let Cu = Components.utils;
let Ci = Components.interfaces;
Cu.import("resource:///modules/source-editor.jsm");
Cu.import("resource:///modules/WebConsoleUtils.jsm");
Cu.import("resource://gre/modules/Services.jsm");

/**
 * Todo
 * . keybindings for linux & windows
 * . Use jsm's
 * . delete listeners & map
 * . underline the current autocompletion item
 * . :connect (remote protocole)
 * . ctrl-r
 * . what to do if page reload?
 */

const JSTERM_MARK = "orion.annotation.jstermobject";

let JSTermUI = {
  input: new SourceEditor(),
  output: new SourceEditor(),
  objects: new Map(),
  printQueue: "",
  printTimeout: null,

  registerCommands: function() {
    this.commands = [
      {name: ":clear", help: "clear screen",
       exec: this.clear.bind(this)},
      {name: ":help", help: "show this help",
       exec: this.help.bind(this)},
      {name: ":toggleLightTheme", help: "Toggle the light (white) theme",
       exec: this.toggleLightTheme.bind(this)},
      {name: "ls", hidden: true, exec: this.ls.bind(this)},
    ];
  },

  get multiline() {
    return this.inputContainer.classList.contains("multiline");
  },

  set multiline(val) {
    if (val)
      this.inputContainer.classList.add("multiline");
    else
      this.inputContainer.classList.remove("multiline");
  },

  focus: function() {
    this.input.focus();
  },

  init: function(aGlobalHistory, aTarget) {
    if (aTarget.type != "tab") {
      throw "Only tabs are supported for the moment.";
    }
    this.target = aTarget.value.linkedBrowser.contentWindow;
    let addonMgr = aTarget.value.ownerDocument.defaultView.AddonManager;

    this.version = "meeh";
    addonMgr.getAddonByID("jsterm@paulrouget.com", function(addon) {
      this.version = addon.version;
    }.bind(this));

    this.registerCommands();

    this.handleKeys = this.handleKeys.bind(this);
    this.handleClick = this.handleClick.bind(this);
    this.focus = this.focus.bind(this);
    this.container = document.querySelector("#editors-container");

    let defaultInputText = "";
    let defaultOutputText = "// type ':help' for help\n// Report bug here: https://github.com/paulrouget/firefox-jsterm/issues";

    this.history = new JSTermLocalHistory(aGlobalHistory);

    let outputContainer = document.querySelector("#output-container");
    this.inputContainer = document.querySelector("#input-container");
    this.output.init(outputContainer, {
      initialText: defaultOutputText,
      mode: SourceEditor.MODES.JAVASCRIPT,
      readOnly: true,
      theme: "chrome://jsterm/content/orion.css",
    }, this.initOutput.bind(this));

    this.input.init(this.inputContainer, {
      initialText: defaultInputText,
      mode: SourceEditor.MODES.JAVASCRIPT,
      theme: "chrome://jsterm/content/orion.css",
    }, this.initInput.bind(this));

    try { // This might be too early. But still, we try.
      if (Services.prefs.getBoolPref("devtools.jsterm.lightTheme")) {
        this._setLightTheme();
      }
    } catch(e){}

  },

  switchToContentMode: function() {
    let label = document.querySelector("#completion-candidates > label");
    let needMessage = !!this.sb;
    let content = this.target;
    this.sb = this.buildSandbox(content);
    if (this.completion) this.completion.destroy();
    this.completion = new JSCompletion(this.input, label, this.sb);
    if (needMessage) {
      this.print("// Switched to content mode.");
    }
    this.inputContainer.classList.remove("chrome");
    window.document.title = "JSTerm: " + content.document.title;
  },

  buildSandbox: function(win) {
    let sb = Cu.Sandbox(win, {sandboxPrototype: win, wantXrays: false});
    this.target = win;
    sb.print = this.print.bind(this);

    sb.$ = function(aSelector) {
      return win.document.querySelector(aSelector);
    };

    sb.$$ = function(aSelector) {
      return win.document.querySelectorAll(aSelector);
    };

    sb.console.log = function(msg) {
      this.print(msg);
    }.bind(this);

    sb.console.clear = function(msg) {
      this.clear();
    }.bind(this);

    return sb;
  },

  print: function(msg = "", startWith = "\n", isAnObject = false, object = null) {
    clearTimeout(this.printTimeout);

    if (isAnObject) {
      // let's do that synchronously, because we want to add a mark
      if (this.printQueue) {
        // flush
        this.output.setText(this.printQueue, this.output.getCharCount());
        this.printQueue = "";
      }
      this.output.setText(startWith + msg, this.output.getCharCount());
      let line = this.output.getLineCount() - 1;
      this.objects.set(line, object);
      this.markRange(line);

    } else {
      this.printQueue += startWith + msg;

      this.printTimeout = setTimeout(function printCommit() {
        this.output.setText(this.printQueue, this.output.getCharCount());
        this.printQueue = "";
      }.bind(this), 0);
    }
  },

  initOutput: function() {
    try {
      if (Services.prefs.getBoolPref("devtools.jsterm.lightTheme")) {
        this._setLightTheme();
      }
    } catch(e){}

    this.makeEditorFitContent(this.output);
    this.ensureInputIsAlwaysVisible(this.output);
    this.output._annotationStyler.addAnnotationType(JSTERM_MARK);
    this.output.editorElement.addEventListener("click", this.handleClick, true);
    this.output.editorElement.addEventListener("keyup", this.focus, true);
  },

  initInput: function() {
    try {
      if (Services.prefs.getBoolPref("devtools.jsterm.lightTheme")) {
        this._setLightTheme();
      }
    } catch(e){}

    this.switchToContentMode();

    this.makeEditorFitContent(this.input);
    this.ensureInputIsAlwaysVisible(this.input);
    this.input.editorElement.addEventListener("keydown", this.handleKeys, true);

    this.input.addEventListener(SourceEditor.EVENTS.TEXT_CHANGED, function() {
      this.multiline = this.isMultiline(this.input.getText());
    }.bind(this));

    this.input.editorElement.ownerDocument.defaultView.setTimeout(function() {
      this.input.focus();
    }.bind(this), 0);
  },

  makeEditorFitContent: function(editor) {
    let lineHeight = editor._view.getLineHeight();
    editor.previousLineCount = editor.getLineCount();
    this.setEditorSize(editor, Math.max(lineHeight * editor.previousLineCount, 1));
    editor.addEventListener(SourceEditor.EVENTS.TEXT_CHANGED, function() {
      let count = editor.getLineCount();
      if (count != editor.previousLineCount) {
        editor.previousLineCount = count;
        this.setEditorSize(editor, lineHeight * count);
      }
    }.bind(this));
  },

  setEditorSize: function(e, height) {
    let winHeight = e.editorElement.ownerDocument.defaultView.innerHeight;
    // We want to resize if the editor doesn't overflow on the Y axis.
    e.editorElement.style.minHeight =
    e.editorElement.style.maxHeight =
    e.editorElement.style.height =
      (e._view.getLineHeight() * e.getLineCount() +
      this.input.editorElement.scrollHeight <= winHeight
        ? (height) + "px"
        : "");
  },

  ensureInputIsAlwaysVisible: function(editor) {
    editor.addEventListener(SourceEditor.EVENTS.TEXT_CHANGED, function() {
      this.container.scrollTop = this.container.scrollTopMax;
    }.bind(this));
  },

  newEntry: function(code) {
    if (this.evaluating) return;
    this.evaluating = true;

    this.history.stopBrowsing();
    this.history.add(code);

    this.input.setText("");
    this.multiline = false;

    if (code == "") {
      this.print();
      this.onceEntryResultPrinted();
      return;
    }

    this.print(code);

    for (let cmd of this.commands) {
      if (cmd.name == code) {
        cmd.exec();
        this.onceEntryResultPrinted();
        return;
      }
    }

    let error, result;
    try {
      result = Cu.evalInSandbox(code, this.sb, "1.8", "JSTerm", 1);
    } catch (ex) {
      error = ex;
    }

    this.dumpEntryResult(result, error, code);
    this.onceEntryResultPrinted();
  },

  onceEntryResultPrinted: function() {
    /* Ugly hack to scrollback */
    this.output.editorElement.contentDocument.querySelector("iframe")
                             .contentDocument.querySelector(".view").scrollLeft = 0;

    /* Clear Selection if any */
    let cursor = this.output.getLineStart(this.output.getLineCount() - 1);
    this.output.setSelection(cursor, cursor);

    this.evaluating = false;
  },

  dumpEntryResult: function(result, error, code) {
    if (error) {
      error = error.toString();
      if (this.isMultiline(error) || this.isMultiline(code)) {
        this.print("/* error:\n" + error + "\n*/");
      } else {
        this.print(" // error: " + error, startWith = "");
      }
      return;
    }

    let isAnArray = Array.isArray(result);
    let isAnObject = !isAnArray && ((typeof result) == "object");
    let isAFunction = ((typeof result) == "function");
    let isAString = (typeof result) == "string";

    let resultStr;
    if (result === undefined) {
      resultStr = "undefined";
    } else if(result === null) {
      resultStr = "null";
      isAnObject = false;
    } else if (isAString) {
      resultStr = "\"" + result + "\"";
    } else if (isAnArray) {
      resultStr = "[" + result.join(", ") + "]";
    } else {
      resultStr = result.toString();
    }

    if (code == resultStr) {
      return;
    }

    if (isAnObject) {
      resultStr += " [+]";
    }

    if (this.isMultiline(resultStr)) {
      if (!isAFunction) {
        resultStr = "\n/*\n" + resultStr + "\n*/";
      } else {
        resultStr = "\n" + resultStr;
      }
    } else {
      if (this.isMultiline(code)) {
        resultStr = "\n// " + resultStr;
      } else {
        resultStr = " // " + resultStr;
      }
    }

    this.print(resultStr, startWith = "", isAnObject, isAnObject ? result : null);
  },

  isMultiline: function(text) {
    return text.indexOf("\n") > -1;
  },

  clear: function() {
    this.objects = new Map();
    this.output.setText("");
    this.hideObjInspector();
  },

  help: function() {
    let text = "/**";
    text += "\n * JSTerm (version " + this.version + ")";
    text += "\n * ";
    text += "\n * 'Return' to evaluate entry,";
    text += "\n * 'Tab' for autocompletion,";
    text += "\n * 'Ctrl-l' clear screen,";
    text += "\n * 'up/down' to browser history,";
    text += "\n * 'Shift+Return' to switch to multiline editing,";
    text += "\n * 'Shift+Return' to evaluate multiline entry,";
    text += "\n * ";
    text += "\n * Use 'print(aString)' to dump text in the terminal,";
    text += "\n * Click on [+] to inspect an object,";
    text += "\n * ";
    text += "\n * Commands:";
    for (let cmd of this.commands) {
      if (cmd.help) {
        text += "\n *   " + cmd.name + " - " + cmd.help;
      }
    }
    text += "\n * ";
    text += "\n * Bugs? Suggestions? Questions? -> https://github.com/paulrouget/firefox-jsterm/issues";
    text += "\n */";
    this.print(text);
  },

  handleKeys: function(e) {
    let code = this.input.getText();

    if (e.keyCode != 38 && e.keyCode != 40) {
      this.history.stopBrowsing();
    }

    if (e.keyCode == 13 && e.shiftKey) {
      if (this.multiline) {
        e.stopPropagation();
        e.preventDefault();
        this.newEntry(code);
      } else {
        this.multiline = true;
      }
    }

    if (e.keyCode == 13 && !e.shiftKey) {
      if (this.multiline) {
        // Do nothing.
      } else {
        e.stopPropagation();
        e.preventDefault();
        this.newEntry(code);
      }
    }

    if (e.keyCode == 76 && e.ctrlKey) {
      e.stopPropagation();
      e.preventDefault();
      this.clear();
    }

    if (e.keyCode == 38) {
      if (!this.history.isBrowsing() && this.multiline) {
        return;
      }
      e.stopPropagation();
      e.preventDefault();
      if (!this.history.isBrowsing() ) {
        this.history.startBrowsing(this.input.getText());
      }
      let entry = this.history.goBack();
      if (entry) {
        JSTermUI.input.setText(entry);
        JSTermUI.input.setCaretPosition(JSTermUI.input.getLineCount(), 1000);
      }
    }
    if (e.keyCode == 40) {
      if (this.history.isBrowsing()) {
        e.stopPropagation();
        e.preventDefault();
        let entry = this.history.goForward();
        JSTermUI.input.setText(entry);
        JSTermUI.input.setCaretPosition(JSTermUI.input.getLineCount(), 1000);
      }
    }
  },

  handleClick: function(e) {
    if (e.target.parentNode && e.target.parentNode.lineIndex) {
      let idx = e.target.parentNode.lineIndex;
      if (this.objects.has(idx)) {
        let obj = this.objects.get(idx);
        e.stopPropagation();
        this.inspect(obj);
      }
    }
  },

  markRange: function(line) {
    let annotation = {
      type: JSTERM_MARK,
      start: this.output.getLineStart(line),
      end: this.output.getLineEnd(line),
      title: "Object",
      lineStyle: {styleClass: "annotationLine object"},
    }
    this.output._annotationModel.addAnnotation(annotation);
  },


  destroy: function() {
    this.input.editorElement.removeEventListener("keydown", this.handleKeys, true);
    this.completion.destroy();
    this.completion = null;
    this.treeview = null;
    this.input = null;
    this.output = null;
    this.objects = null;
    this.printQueue = null;
    this.printTimeout = null;
  },

  inspect: function(obj, filter) {
    let treeview = this.treeview = new PropertyTreeView2();
    treeview.data = {object:obj};
    let tree = document.querySelector("#object-inspector > tree");
    tree.view = treeview;
    let box = document.querySelector("#object-inspector");
    box.hidden = false;
    this.focus();
  },

  hideObjInspector: function() {
    let box = document.querySelector("#object-inspector");
    box.hidden = true;
  },

  filterObjInspector: function(input) {
    this.treeview.filter(input.value);
  },

  getContent: function() {
    return {
      input: this.input.getText(),
      output: this.output.getText(),
    };
  },

  ls: function() {
    this.print("// Did you just type \"ls\"? You know this is not a unix shell, right?");
  },

  toggleLightTheme: function() {
    let isLight = document.documentElement.classList.contains("light");

    Services.prefs.setBoolPref("devtools.jsterm.lightTheme", !isLight);

    if (isLight) {
      this._setDarkTheme();
    } else {
      this._setLightTheme();
    }
  },

  _setLightTheme: function() {
    document.documentElement.classList.add("light");
    let inputView = this.input.editorElement.contentDocument.querySelector("iframe")
                                            .contentDocument.querySelector(".view");
    inputView.classList.add("light");
    let outputView = this.output.editorElement.contentDocument.querySelector("iframe")
                                              .contentDocument.querySelector(".view");
    outputView.classList.add("light");
  },

  _setDarkTheme: function() {
    document.documentElement.classList.remove("light");
    let inputView = this.input.editorElement.contentDocument.querySelector("iframe")
                                            .contentDocument.querySelector(".view");
    inputView.classList.remove("light");
    let outputView = this.output.editorElement.contentDocument.querySelector("iframe")
                                            .contentDocument.querySelector(".view");
    outputView.classList.remove("light");
  },
}



/* Auto Completion */

function JSCompletion(editor, candidatesWidget, sandbox) {
  this.editor = editor;
  this.candidatesWidget = candidatesWidget;

  this.handleKeys = this.handleKeys.bind(this);

  this.editor.editorElement.addEventListener("keydown", this.handleKeys, true);

  this.buildDictionnary();

  this.sb = sandbox;
}

JSCompletion.prototype = {
  buildDictionnary: function() {
    let JSKeywords = "break delete case do catch else class export continue finally const for debugger function default if import this in throw instanceof try let typeof new var return void super while switch with";
    this.dictionnary = JSKeywords.split(" ");
    for (let cmd of JSTermUI.commands) {
      if (!cmd.hidden) {
        this.dictionnary.push(cmd.name);
      }
    }
  },
  handleKeys: function(e) {
    if (e.keyCode == 9) {
      this.handleTab(e);
    } else {
      this.stopCompletion();
    }
  },
  handleTab: function(e) {
    if (this.isCompleting) {
      this.continueCompleting();
      e.stopPropagation();
      e.preventDefault();
      return;
    }

    // Can we complete?
    let caret = this.editor.getCaretPosition();
    if (caret.col == 0) return;

    let lines = this.editor.getText().split("\n");
    let line = lines[caret.line]
    let previousChar = line[caret.col - 1];

    if (!previousChar.match(/\w|\.|:/i)) return;

    // Initiate Completion
    e.preventDefault();
    e.stopPropagation();

    let root = line.substr(0, caret.col);

    let candidates = JSPropertyProvider(this.sb, root);

    let completeFromDict = false;
    if (candidates && candidates.matchProp) {
      if (root.length == candidates.matchProp.length) {
        completeFromDict = true;
      } else {
        let charBeforeProp = root[root.length - candidates.matchProp.length - 1];
        if (charBeforeProp.match(/\s|{|;|\(/)) {
          completeFromDict = true;
        }
      }
    }
    if (completeFromDict) {
      for (let word of this.dictionnary) {
        if (word.indexOf(candidates.matchProp) == 0) {
          candidates.matches.push(word);
        }
      }
    }

    if (!candidates || candidates.matches.length == 0) return;

    let offset = this.editor.getCaretOffset();

    // if one candidate
    if (candidates.matches.length == 1) {
      let suffix = candidates.matches[0].substr(candidates.matchProp.length);
      this.editor.setText(suffix, offset, offset);
      return;
    }

    // if several candidate

    let commonPrefix = candidates.matches.reduce(function(commonPrefix, nextValue) {
      if (commonPrefix == "")
        return "";

      if (!commonPrefix)
        return nextValue;

      if (commonPrefix.length > nextValue.length) {
        commonPrefix = commonPrefix.substr(0, nextValue.length);
      }
      let res = "";
      let idx = 0;
      for (let p = 0; p < commonPrefix.length; p++) {
        let c = commonPrefix[p];
        if (nextValue[idx++] == c)
          res += c;
        else
          break;
      }
      return res;
    });

    if (commonPrefix) {
      let suffix = commonPrefix.substr(candidates.matchProp.length);
      this.editor.setText(suffix, offset, offset);
      offset += suffix.length;
      candidates.matchProp = commonPrefix;
    }

    this.whereToInsert = {start: offset, end: offset};
    this.candidates = candidates;
    this.candidatesWidget.setAttribute("value", this.candidates.matches.join(" "));
    this.isCompleting = true;

    if (this.candidates.matches[0] == this.candidates.matchProp)
      this.candidatesIndex = 0;
    else
      this.candidatesIndex = -1;
  },

  continueCompleting: function() {
    this.candidatesIndex++;
    if (this.candidatesIndex == this.candidates.matches.length) {
      this.candidatesIndex = 0;
    }

    let prefixLength = this.candidates.matchProp.length;
    let suffix = this.candidates.matches[this.candidatesIndex].substr(prefixLength);
    this.editor.setText(suffix, this.whereToInsert.start, this.whereToInsert.end);
    this.whereToInsert.end = this.whereToInsert.start + suffix.length;
  },

  stopCompletion: function() {
    if (!this.isCompleting) return;
    this.candidatesWidget.setAttribute("value", "");
    this.isCompleting = false;
    this.candidates = null;
  },
  destroy: function() {
    this.editor.editorElement.removeEventListener("keydown", this.handleKeys, true);
    this.editor = null;
  },
}




///////////////////////////////////////////////////////////////////////////
//// PropertyTreeView2

/**
 * This is an implementation of the nsITreeView interface. For comments on the
 * interface properties, see the documentation:
 * https://developer.mozilla.org/en/XPCOM_Interface_Reference/nsITreeView
 */
var PropertyTreeView2 = function() {
  this._rows = [];
  this._objectCache = {};
};

PropertyTreeView2.prototype = {
  /**
   * Stores the visible rows of the tree.
   * @private
   */
  _rows: null,

  /**
   * Stores the nsITreeBoxObject for this tree.
   * @private
   */
  _treeBox: null,

  /**
   * Stores cached information about local objects being inspected.
   * @private
   */
  _objectCache: null,

  /**
   * Use this setter to update the content of the tree.
   *
   * @param object aData
   *        A meta object that holds information about the object you want to
   *        display in the property panel. Object properties:
   *        - object:
   *        This is the raw object you want to display. You can only provide
   *        this object if you want the property panel to work in sync mode.
   *        - remoteObject:
   *        An array that holds information on the remote object being
   *        inspected. Each element in this array describes each property in the
   *        remote object. See WebConsoleUtils.namesAndValuesOf() for details.
   *        - rootCacheId:
   *        The cache ID where the objects referenced in remoteObject are found.
   *        - panelCacheId:
   *        The cache ID where any object retrieved by this property panel
   *        instance should be stored into.
   *        - remoteObjectProvider:
   *        A function that is invoked when a new object is needed. This is
   *        called when the user tries to expand an inspectable property. The
   *        callback must take four arguments:
   *          - fromCacheId:
   *          Tells from where to retrieve the object the user picked (from
   *          which cache ID).
   *          - objectId:
   *          The object ID the user wants.
   *          - panelCacheId:
   *          Tells in which cache ID to store the objects referenced by
   *          objectId so they can be retrieved later.
   *          - callback:
   *          The callback function to be invoked when the remote object is
   *          received. This function takes one argument: the raw message
   *          received from the Web Console content script.
   */
  set data(aData) {
    let oldLen = this._rows.length;

    this._cleanup();

    if (!aData) {
      return;
    }

    if (aData.remoteObject) {
      this._rootCacheId = aData.rootCacheId;
      this._panelCacheId = aData.panelCacheId;
      this._remoteObjectProvider = aData.remoteObjectProvider;
      this._rows = [].concat(aData.remoteObject);
      this._updateRemoteObject(this._rows, 0);
    }
    else if (aData.object) {
      this._rows = this._inspectObject(aData.object);
    }
    else {
      throw new Error("First argument must have a .remoteObject or " +
                      "an .object property!");
    }

    this._unfilteredRows = this._rows;

    if (this._treeBox) {
      this._treeBox.beginUpdateBatch();
      if (oldLen) {
        this._treeBox.rowCountChanged(0, -oldLen);
      }
      this._treeBox.rowCountChanged(0, this._rows.length);
      this._treeBox.endUpdateBatch();
    }
  },

  /**
   * Update a remote object so it can be used with the tree view. This method
   * adds properties to each array element.
   *
   * @private
   * @param array aObject
   *        The remote object you want prepared for use with the tree view.
   * @param number aLevel
   *        The level you want to give to each property in the remote object.
   */
  _updateRemoteObject: function PTV__updateRemoteObject(aObject, aLevel)
  {
    aObject.forEach(function(aElement) {
      aElement.level = aLevel;
      aElement.isOpened = false;
      aElement.children = null;
    });
  },

  /**
   * Inspect a local object.
   *
   * @private
   * @param object aObject
   *        The object you want to inspect.
   */
  _inspectObject: function PTV__inspectObject(aObject, filter)
  {
    this._objectCache = {};
    this._remoteObjectProvider = this._localObjectProvider.bind(this);
    let children = WebConsoleUtils.namesAndValuesOf(aObject, this._objectCache);
    this._updateRemoteObject(children, 0);
    return children;
  },

  /**
   * An object provider for when the user inspects local objects (not remote
   * ones).
   *
   * @private
   * @param string aFromCacheId
   *        The cache ID from where to retrieve the desired object.
   * @param string aObjectId
   *        The ID of the object you want.
   * @param string aDestCacheId
   *        The ID of the cache where to store any objects referenced by the
   *        desired object.
   * @param function aCallback
   *        The function you want to receive the object.
   */
  _localObjectProvider:
  function PTV__localObjectProvider(aFromCacheId, aObjectId, aDestCacheId,
                                    aCallback)
  {
    let object = WebConsoleUtils.namesAndValuesOf(this._objectCache[aObjectId],
                                                  this._objectCache);
    aCallback({cacheId: aFromCacheId,
               objectId: aObjectId,
               object: object,
               childrenCacheId: aDestCacheId || aFromCacheId,
    });
  },

  /** nsITreeView interface implementation **/

  selection: null,

  get rowCount()                     { return this._rows.length; },
  setTree: function(treeBox)         { this._treeBox = treeBox;  },
  getCellText: function(idx, column) {
    let row = this._rows[idx];
    if (column.id == "propName") {
      return row.name;
    } else {
      return row.value;
    }
  },
  getLevel: function(idx) {
    return this._rows[idx].level;
  },
  isContainer: function(idx) {
    return !!this._rows[idx].inspectable;
  },
  isContainerOpen: function(idx) {
    return this._rows[idx].isOpened;
  },
  isContainerEmpty: function(idx)    { return false; },
  isSeparator: function(idx)         { return false; },
  isSorted: function()               { return false; },
  isEditable: function(idx, column)  { return false; },
  isSelectable: function(row, col)   { return true; },

  getParentIndex: function(idx)
  {
    if (this.getLevel(idx) == 0) {
      return -1;
    }
    for (var t = idx - 1; t >= 0; t--) {
      if (this.isContainer(t)) {
        return t;
      }
    }
    return -1;
  },

  hasNextSibling: function(idx, after)
  {
    var thisLevel = this.getLevel(idx);
    return this._rows.slice(after + 1).some(function (r) r.level == thisLevel);
  },

  toggleOpenState: function(idx)
  {
    let item = this._rows[idx];
    if (!item.inspectable) {
      return;
    }

    if (item.isOpened) {
      this._treeBox.beginUpdateBatch();
      item.isOpened = false;

      var thisLevel = item.level;
      var t = idx + 1, deleteCount = 0;
      while (t < this._rows.length && this.getLevel(t++) > thisLevel) {
        deleteCount++;
      }

      if (deleteCount) {
        this._rows.splice(idx + 1, deleteCount);
        this._treeBox.rowCountChanged(idx + 1, -deleteCount);
      }
      this._treeBox.invalidateRow(idx);
      this._treeBox.endUpdateBatch();
    }
    else {
      let levelUpdate = true;
      let callback = function _onRemoteResponse(aResponse) {
        this._treeBox.beginUpdateBatch();
        item.isOpened = true;

        if (levelUpdate) {
          this._updateRemoteObject(aResponse.object, item.level + 1);
          item.children = aResponse.object;
        }

        this._rows.splice.apply(this._rows, [idx + 1, 0].concat(item.children));

        this._treeBox.rowCountChanged(idx + 1, item.children.length);
        this._treeBox.invalidateRow(idx);
        this._treeBox.endUpdateBatch();
      }.bind(this);

      if (!item.children) {
        let fromCacheId = item.level > 0 ? this._panelCacheId :
                                           this._rootCacheId;
        this._remoteObjectProvider(fromCacheId, item.objectId,
                                   this._panelCacheId, callback);
      }
      else {
        levelUpdate = false;
        callback({object: item.children});
      }
    }
  },

  getImageSrc: function(idx, column) { },
  getProgressMode : function(idx,column) { },
  getCellValue: function(idx, column) { },
  cycleHeader: function(col, elem) { },
  selectionChanged: function() { },
  cycleCell: function(idx, column) { },
  performAction: function(action) { },
  performActionOnCell: function(action, index, column) { },
  performActionOnRow: function(action, row) { },
  getRowProperties: function(idx, column, prop) { },
  getCellProperties: function(idx, column, prop) { },
  getColumnProperties: function(column, element, prop) { },

  setCellValue: function(row, col, value)               { },
  setCellText: function(row, col, value)                { },
  drop: function(index, orientation, dataTransfer)      { },
  canDrop: function(index, orientation, dataTransfer)   { return false; },

  _cleanup: function PTV__cleanup()
  {
    if (this._rows.length) {
      // Reset the existing _rows children to the initial state.
      this._updateRemoteObject(this._rows, 0);
      this._rows = [];
    }

    delete this._objectCache;
    delete this._rootCacheId;
    delete this._panelCacheId;
    delete this._remoteObjectProvider;
  },

  /* Filter mechanism */
  filter: function(filter) {
    let oldLen = this._rows.length;
    let treeview = this;

    let reverse = false;
    if (filter.length > 1 && filter[0] == "-") {
      filter = filter.substr(1);
      reverse = true;
    }

    let regex = new RegExp(filter, "i");
    this._rows = this._unfilteredRows.filter(function(e, idx) {
      e.isOpened = false;
      if (reverse) {
        return !regex.test(e.name) && !regex.test(e.value);
      }
      return regex.test(e.name) || regex.test(e.value);
    });
    this._treeBox.rowCountChanged(0, -oldLen);
    this._treeBox.rowCountChanged(0, this._rows.length);
  },
};

/** HISTORY **/

function JSTermLocalHistory(aGlobalHistory) {
  this.global = aGlobalHistory;
}
JSTermLocalHistory.prototype = {
  _browsing: false,
  isBrowsing: function() {
    return this._browsing;
  },
  startBrowsing: function(aInitialValue) {
    this._browsing = true;
    this.cursor = this.global.getCursor(aInitialValue);
  },
  stopBrowsing: function() {
    if (this.isBrowsing()) {
      this._browsing = false;
      this.global.releaseCursor(this.cursor);
      this.cursor = null;
    }
  },
  add: function(entry) {
      this.global.add(entry);
  },
  canGoBack: function() {
    return this.isBrowsing() && this.global.canGoBack(this.cursor);
  },
  canGoForward: function() {
    return this.isBrowsing() && this.global.canGoForward(this.cursor);
  },
  goBack: function() {
    if (this.canGoBack()) {
      this.global.goBack(this.cursor);
      let entry = this.global.getEntryForCursor(this.cursor);
      return entry;
    }
    return null;
  },
  goForward: function() {
    if (this.canGoForward()) {
      this.global.goForward(this.cursor);
      let entry = this.global.getEntryForCursor(this.cursor);
      return entry;
    }
    return null;
  },
}
