let Cu = Components.utils;
let Ci = Components.interfaces;
Cu.import("resource:///modules/source-editor.jsm");
Cu.import("resource:///modules/WebConsoleUtils.jsm");

/**
 * Todo
 * . ctrl-c should copy the output selection if any
 * . delete listeners & map
 * . checkbox status
 * . highlight common DOM keywords
 * . save history and share it
 * . make tree width persistent
 */

const JSTERM_MARK = "orion.annotation.jstermobject";

let JSTermUI = {
  input: new SourceEditor(),
  output: new SourceEditor(),
  objects: new Map(),

  close: function() {
    this.manager.closeForBrowser(this.browser);
  },

  registerCommands: function() {
    this.commands = [
      {name: ":close", help: "close terminal",
       exec: this.close.bind(this)},
      {name: ":clear", help: "clear screen",
       exec: this.clear.bind(this)},
      {name: ":help", help: "show this help",
       exec: this.help.bind(this)},
      {name: ":content", help: "switch to Content mode",
       exec: this.switchToContentMode.bind(this)},
      {name: ":chrome", help: "switch to Chrome mode",
       exec: this.switchToChromeMode.bind(this)},
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

  init: function(aManager, aBrowser, aContent, aChrome) {
    this.manager = aManager;
    this.browser = aBrowser;
    this.content = aContent;
    this.chrome = aChrome;

    this.registerCommands();

    this.handleKeys = this.handleKeys.bind(this);
    this.handleClick = this.handleClick.bind(this);
    this.focus = this.focus.bind(this);
    this.container = document.querySelector("#editors-container");

    let outputContainer = document.querySelector("#output-container");
    this.inputContainer = document.querySelector("#input-container");
    this.output.init(outputContainer, {
      initialText: "// type ':help' for help",
      mode: SourceEditor.MODES.JAVASCRIPT,
      readOnly: true,
      theme: "chrome://jsterm/content/orion.css",
    }, this.initOutput.bind(this));

    this.input.init(this.inputContainer, {
      mode: SourceEditor.MODES.JAVASCRIPT,
      theme: "chrome://jsterm/content/orion.css",
    }, this.initInput.bind(this));

  },

  switchToChromeMode: function() {
    let label = document.querySelector("#completion-candidates > label");
    this.sb = this.buildSandbox(this.chrome);
    this.output.setText(" // Switched to chrome mode.", this.output.getCharCount());
    if (this.completion) this.completion.destroy();
    this.completion = new JSCompletion(this.input, label, this.sb);
    this.inputContainer.classList.add("chrome");
  },

  switchToContentMode: function() {
    let label = document.querySelector("#completion-candidates > label");
    let needMessage = !!this.sb;
    this.sb = this.buildSandbox(this.content);
    if (this.completion) this.completion.destroy();
    this.completion = new JSCompletion(this.input, label, this.sb);
    if (needMessage) {
      this.output.setText(" // Switched to content mode.", this.output.getCharCount());
    }
    this.inputContainer.classList.remove("chrome");
  },

  buildSandbox: function(win) {
    let sb = Cu.Sandbox(win, {sandboxPrototype: win, wantXrays: false});
    sb.print = function(msg) {
      this.printedSomething = true;
      this.output.setText("\n" + msg, this.output.getCharCount());
    }.bind(this);
    return sb;
  },

  initOutput: function() {
    this.makeEditorFitContent(this.output);
    this.ensureInputIsAlwaysVisible(this.output);
    this.output._annotationStyler.addAnnotationType(JSTERM_MARK);
    this.output.editorElement.addEventListener("click", this.handleClick, true);
    this.output.editorElement.addEventListener("keydown", this.focus, true);
  },

  initInput: function() {
    this.history.init();
    this.switchToContentMode();

    this.makeEditorFitContent(this.input);
    this.ensureInputIsAlwaysVisible(this.input);
    this.input.editorElement.addEventListener("keydown", this.handleKeys, true);
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
    e.editorElement.style.minHeight =
    e.editorElement.style.maxHeight =
    e.editorElement.style.height = (height) + "px";
  },

  history: {
    _entries: [],
    cursor: 0,
    browsing: false,
    init: function() {
      JSTermUI.input.addEventListener(SourceEditor.EVENTS.SELECTION, function() {
        this.browsing = false;
      }.bind(this));

    },
    add: function(entry) {
      if (!entry) return;
      if (this._entries.length) {
        let lastEntry = this._entries[this._entries.length - 1];
        if (lastEntry == entry)
          return;
      }
      this._entries.push(entry);
    },

    startBrowsing: function(originalText) {
      this.originalText = originalText;
      this.browsing = true;
      this.cursor = this._entries.length;
    },
    goBack: function() {
      if (this.canGoBack()) {
        this.cursor--;
        let entry = this.getEntryAtIndex(this.cursor);
        JSTermUI.input.setText(entry);
        JSTermUI.input.setCaretPosition(JSTermUI.input.getLineCount(), 1000);
        if (JSTermUI.isMultiline(entry)) {
          JSTermUI.multiline = true;
        } else {
          JSTermUI.multiline = false;
        }
        this.browsing = true;
      }
    },
    goForward: function() {
      if (this.canGoForward()) {
        this.cursor++;
        let entry = this.getEntryAtIndex(this.cursor);
        JSTermUI.input.setText(entry);
        JSTermUI.input.setCaretPosition(JSTermUI.input.getLineCount(), 1000);
        if (JSTermUI.isMultiline(entry)) {
          JSTermUI.multiline = true;
        } else {
          JSTermUI.multiline = false;
        }
        this.browsing = true;
      }
    },
    canGoBack: function() {
      return this.browsing && (this.cursor > 0);
    },
    canGoForward: function() {
      return this.browsing && (this.cursor < this._entries.length);
    },
    getEntryAtIndex: function(idx) {
      if (idx == this._entries.length) {
        return this.originalText;
      }
      return this._entries[idx];
    },
  },

  ensureInputIsAlwaysVisible: function(editor) {
    editor.addEventListener(SourceEditor.EVENTS.TEXT_CHANGED, function() {
      this.container.scrollTop = this.container.scrollTopMax;
    }.bind(this));
  },

  newEntry: function(code) {
    this.history.add(code);
    this.input.setText("");
    this.multiline = false;
    this.printedSomething = false;

    if (code == "") {
      this.output.setText("\n", this.output.getCharCount());
      return;
    }

    this.output.setText("\n" + code, this.output.getCharCount());

    for (let cmd of this.commands) {
      if (cmd.name == code) {
        cmd.exec();
        return;
      }
    }

    let error, result;
    try {
      result = Cu.evalInSandbox(code, this.sb, "1.8", "JSTerm", 1);
    } catch (ex) {
      error = ex;
    }

    if (error) {
      error = error.toString();
      if (this.isMultiline(error) || this.isMultiline(code) || this.printedSomething) {
        this.output.setText("\n/* error:\n" + error + "\n*/", this.output.getCharCount());
      } else {
        this.output.setText(" // error: " + error, this.output.getCharCount());
      }
    } else {
      if ((typeof result) == "string") {
        result = "\"" + result + "\"";
      }

      let isAnObject = (typeof result) == "object";
      let resultStr;

      if (result == undefined) {
        resultStr = "undefined";
      } else {
        resultStr = result.toString();
      }

      if (isAnObject) {
        resultStr += " [+]";
      }

      if (code == resultStr) {
        // Do nothing
      } else {
        if (this.isMultiline(code) || this.printedSomething) {
          if (result == undefined && this.printedSomething) {
            // Do nothing. I don't think it's interesting to print "undefined" in this case.
          } else if (this.isMultiline(resultStr)) {
            this.output.setText("\n/*\n" + resultStr + "\n*/", this.output.getCharCount());
          } else {
            this.output.setText("\n// " + resultStr, this.output.getCharCount());
          }
        } else {
          if (this.isMultiline(resultStr)) {
            this.output.setText("\n/*\n" + resultStr + "\n*/", this.output.getCharCount());
          } else {
            this.output.setText(" // " + resultStr, this.output.getCharCount());
          }
        }
        if (isAnObject) {
          let line = this.output.getLineCount() - 1;
          this.objects.set(line, result);
          this.markRange(line);
        }
      }
    }
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
    let text = "\n/**";
    text += "\n * 'Return' to evaluate entry,";
    text += "\n * 'Tab' for autocompletion,";
    text += "\n * 'Ctrl-l' clear screen,";
    text += "\n * 'Ctrl-d' close term,";
    text += "\n * 'up/down' to browser history,";
    text += "\n * 'Shift+Return' to switch to multiline editing,";
    text += "\n * 'Shift+Return' to evaluate multiline entry,";
    text += "\n * ";
    text += "\n * Use 'print(aString)' to dump text in the terminal,";
    text += "\n * ";
    text += "\n * Commands:";
    for (let cmd of this.commands) {
      text += "\n *   " + cmd.name + " - " + cmd.help;
    }
    text += "\n */";
    this.output.setText(text, this.output.getCharCount());
  },

  handleKeys: function(e) {
    let code = this.input.getText();

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

    if (e.keyCode == 68 && e.ctrlKey) {
      e.stopPropagation();
      e.preventDefault();
      this.close();
    }
    if (e.keyCode == 76 && e.ctrlKey) {
      e.stopPropagation();
      e.preventDefault();
      this.clear();
    }

    if (e.keyCode == 38) {
      if (!this.history.browsing && this.multiline) {
        return;
      }
      e.stopPropagation();
      e.preventDefault();
      if (!this.history.browsing) {
        this.history.startBrowsing(this.input.getText());
      }
      this.history.goBack();
    }
    if (e.keyCode == 40) {
      if (this.history.browsing) {
        e.stopPropagation();
        e.preventDefault();
        this.history.goForward();
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
      this.dictionnary.push(cmd.name);
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
