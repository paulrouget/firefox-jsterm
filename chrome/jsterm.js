let Cu = Components.utils;
let Ci = Components.interfaces;
Cu.import("resource:///modules/source-editor.jsm");
Cu.import("resource://gre/modules/devtools/WebConsoleUtils.jsm");
Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource:///modules/devtools/VariablesView.jsm");

/**
 * Todo
 * . keybindings for linux & windows
 * . Use jsm's
 * . delete listeners & map
 * . underline the current autocompletion item
 * . :connect (remote protocol)
 * . ctrl-r
 */

const JSTERM_MARK = "orion.annotation.jstermobject";

const compilers = {
  js: function(input) {
    return input;
  },
  coffee: function(input) {
    return CoffeeScript.compile(input, {bare: true}).trim();
  },
  livescript: function(input) {
    return LiveScript.compile(input, {bare: true}).trim();
  }
};

let JSTermUI = {
  input: new SourceEditor(),
  output: new SourceEditor(),
  objects: new Map(),
  printQueue: "",
  printTimeout: null,

  close: function() {
    this.toolbox.destroy();
  },

  registerCommands: function() {
    this.commands = [
      {name: ":close", help: "close terminal",
       exec: this.close.bind(this)},
      {name: ":clear", help: "clear screen",
       exec: this.clear.bind(this)},
      {name: ":help", help: "show this help",
       exec: this.help.bind(this)},
      {name: ":js", help: "switch to JS language",
       exec: this.switchToLanguage.bind(this, 'js')},
      {name: ":coffee", help: "switch to CoffeeScript language",
       exec: this.switchToLanguage.bind(this, 'coffee')},
      {name: ":livescript", help: "switch to LiveScript language",
       exec: this.switchToLanguage.bind(this, 'livescript')},
      {name: ":content", help: "switch to Content mode",
       exec: this.switchToContentMode.bind(this)},
      {name: ":chrome", help: "switch to Chrome mode",
       exec: this.switchToChromeMode.bind(this)},
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

  //init: function(aManager, aGlobalHistory, aBrowser, aContent, aChrome, aDefaultContent) {
  init: function(aGlobalHistory, aToolbox) {
    this.toolbox = aToolbox;

    this.content = this.toolbox.target.tab.linkedBrowser.contentWindow;
    this.chrome = this.toolbox.target.tab.ownerDocument.defaultView;
    this.switchToLanguage('livescript');
    this.logCompiledCode = false;

    this.version = "n/a";
    this.chrome.AddonManager.getAddonByID("jsterm@paulrouget.com", function(addon) {
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

    this.variableView = new VariablesView(document.querySelector("#variables"));

    try { // This might be too early. But still, we try.
      if (Services.prefs.getBoolPref("devtools.jsterm.lightTheme")) {
        this._setLightTheme();
      }
    } catch(e){}

  },

  switchToChromeMode: function() {
    let label = document.querySelector("#completion-candidates > label");
    this.sb = this.buildSandbox(this.chrome);
    this.print("// Switched to chrome mode.");
    if (this.completion) this.completion.destroy();
    this.completion = new JSCompletion(this.input, label, this.sb);
    this.inputContainer.classList.add("chrome");
    window.document.title = "JSTerm: (chrome) " + this.chrome.document.title;
  },

  switchToLanguage: function(language) {
    this.languageName = language;
    this.compile = compilers[language].bind(this);
  },

  switchToContentMode: function() {
    let label = document.querySelector("#completion-candidates > label");
    let needMessage = !!this.sb;
    this.sb = this.buildSandbox(this.content);
    if (this.completion) this.completion.destroy();
    this.completion = new JSCompletion(this.input, label, this.sb);
    if (needMessage) {
      this.print("// Switched to content mode.");
    }
    this.inputContainer.classList.remove("chrome");
    window.document.title = "JSTerm: " + this.content.document.title;
  },

  buildSandbox: function(win) {
    let sb = Cu.Sandbox(win, {sandboxPrototype: win, wantXrays: false});
    this.target = win;
    sb.print = this.print.bind(this);

    let defineProp = function(name, prop) {
      if (hasOwnProperty.call(sb, name)) return;
      try {
        sb[name] = prop
      } catch(ex) {}
    };

    defineProp('$', function(aSelector) {
      return win.document.querySelector(aSelector);
    });

    defineProp('$$', function(aSelector) {
      return win.document.querySelectorAll(aSelector);
    });

    if (this.languageName === 'livescript') {
      for (let key in prelude) {
        defineProp(key, prelude[key]);
      }
    }

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

  newEntry: function(rawCode) {
    if (this.evaluating) return;
    this.evaluating = true;

    this.history.stopBrowsing();
    this.history.add(rawCode);

    this.input.setText("");
    this.multiline = false;

    if (rawCode == "") {
      this.print();
      this.onceEntryResultPrinted();
      return;
    }

    for (let cmd of this.commands) {
      if (cmd.name == rawCode) {
        this.print(rawCode);
        cmd.exec();
        this.onceEntryResultPrinted();
        return;
      }
    }

    let code;

    try {
      code = this.compile(rawCode);
    } catch(ex) {
      this.dumpEntryResult('', ex.toString().slice(7), rawCode);
      this.onceEntryResultPrinted();
      return;
    }

    var output = this.languageName != 'js' && this.logCompiledCode ?
      rawCode + '\n\n/*' + code + '*/' : rawCode;
    this.print(output);

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
    text += "\n * 'Ctrl-d' close term,";
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

  inspect: function(obj) {
    let box = document.querySelector("#variables");
    box.hidden = false;
    this.variableView.rawObject = obj;
    this.focus();
  },

  hideObjInspector: function() {
    this.variableView.empty();
    let box = document.querySelector("#variables");
    box.hidden = true;
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
