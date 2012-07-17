let Cu = Components.utils;
let Ci = Components.interfaces;
Cu.import("resource:///modules/source-editor.jsm");
Cu.import("resource:///modules/WebConsoleUtils.jsm");

/**
 * Todo
 * . change style on multiline
 * . change font
 * . add object inspector
 * . ctrl-c should copy the output selection if any
 * . delete listeners & map
 * . checkbox status
 * . multiline history
 * . chrome mode
 * . use getLineDelimiter
 */

const JSTERM_MARK = "orion.annotation.jstermobject";

let JSTermUI = {
  input: new SourceEditor(),
  output: new SourceEditor(),
  objects: new Map(),

  focus: function() {
    this.input.focus();
  },

  init: function() {
    this.content = window.parent.gBrowser.contentWindow;
    this.sb = Cu.Sandbox(this.content, {sandboxPrototype: this.content, wantXrays: false});

    this.handleKeys = this.handleKeys.bind(this);
    this.handleClick = this.handleClick.bind(this);
    this.focus = this.focus.bind(this);
    this.container = document.querySelector("#editors-container");

    let outputContainer = document.querySelector("#output-container");
    let inputContainer = document.querySelector("#input-container");
    this.output.init(outputContainer, {
      initialText: "/* JavaScript Terminal.\n   'Return' to execute\n   'Shift-Return' to toggle multiline-mode\n*/\n",
      mode: SourceEditor.MODES.JAVASCRIPT,
      readOnly: true,
      theme: "chrome://jsterm/content/orion.css",
    }, this.initOutput.bind(this));

    this.input.init(inputContainer, {
      mode: SourceEditor.MODES.JAVASCRIPT,
      keys: [{action: "Clear output",
             code: Ci.nsIDOMKeyEvent.DOM_VK_L,
             callback: this.clear.bind(this),
             ctrl: true}],
      theme: "chrome://jsterm/content/orion.css",
    }, this.initInput.bind(this));

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

    let label = document.querySelector("#completion-candidates > label");
    this.completion = new JSCompletion(this.input, label, this.sb);

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
      JSTermUI.input.addEventListener(SourceEditor.EVENTS.TEXT_CHANGED, function() {
        this.browsing = false;
      }.bind(this));

    },
    add: function(entry) {
      if (!entry) return;
      if (JSTermUI.isMultiline(entry)) return;
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
        JSTermUI.input.setText(this.getEntryAtIndex(this.cursor));
        JSTermUI.input.setCaretPosition(JSTermUI.input.getLineCount(), 1000);
        this.browsing = true;
      }
    },
    goForward: function() {
      if (this.canGoForward()) {
        this.cursor++;
        JSTermUI.input.setText(this.getEntryAtIndex(this.cursor));
        JSTermUI.input.setCaretPosition(JSTermUI.input.getLineCount(), 1000);
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

    let lastLineCount = this.output.getLineCount();

    if (code == ":clear") {
      this.clear();
      return;
    }

    if (code == ":help") {
      this.output.setText("\nHelp: FIXME", this.output.getCharCount());
      return;
    }


    let error, result;
    try {
      result = Cu.evalInSandbox(code, this.sb, "1.8", "JSTerm", 1);
    } catch (ex) {
      error = ex;
    }

    if (error) {
      error = error.toString();
      if (this.isMultiline(error)) {

        this.output.setText("\n" + code + "\n/* error:\n" + error + "\n*/", this.output.getCharCount());
      } else {
        this.output.setText("\n" + code + "\n// error: " + error, this.output.getCharCount());
      }
    } else {
      if ((typeof result) == "string") {
        result = "\"" + result + "\"";
      }
      if (result == undefined) {
        result = "undefined";
      }

      let lastLineCount = this.output.getLineCount();
      let isAnObject = ((typeof result) == "object");

      let objectAtLine = null;

      let resultStr = result.toString();

      if (isAnObject)
        resultStr = "// " + resultStr;
      if (code == resultStr) {
        this.output.setText("\n" + code, this.output.getCharCount());
      } else if (code) {
        this.output.setText("\n" + code + "\n" + resultStr, this.output.getCharCount());
        if (isAnObject) objectAtLine = lastLineCount + 1;
      } else {
        this.output.setText("\n", this.output.getCharCount());
      }

      if (isAnObject) {
        this.objects.set(objectAtLine, result);
        this.markRange(objectAtLine);
      }
    }
  },

  isMultiline: function(text) {
    return text.indexOf("\n") > -1;
  },

  clear: function() {
    this.output.setText("");
  },

  handleKeys: function(e) {
    let code = this.input.getText();
    let isMultiline = this.isMultiline(code);
    if (e.keyCode == 13 && ((!e.shiftKey && !isMultiline) || (e.shiftKey && isMultiline))) { // ENTER
      e.stopPropagation();
      e.preventDefault();
     this.newEntry(code);
    }
    if (!isMultiline && e.keyCode == 38) {
      e.stopPropagation();
      e.preventDefault();
      if (!this.history.browsing) this.history.startBrowsing(this.input.getText());
      this.history.goBack();
    }
    if (!isMultiline && e.keyCode == 40) {
      e.stopPropagation();
      e.preventDefault();
      this.history.goForward();
    }

  },

  handleClick: function(e) {
    if (e.target.parentNode && e.target.parentNode.lineIndex) {
      let idx = e.target.parentNode.lineIndex;
      if (this.objects.has(idx)) {
        let obj = this.objects.get(idx);
        e.stopPropagation();
        dump("\n INSPECT: " + obj + "\n");
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
  },
}



/* Auto Completion */

function JSCompletion(editor, candidatesWidget, sandbox) {
  this.editor = editor;
  this.candidatesWidget = candidatesWidget;

  this.handleKeys = this.handleKeys.bind(this);

  this.editor.editorElement.addEventListener("keydown", this.handleKeys, true);

  this.sb = sandbox;
}

JSCompletion.prototype = {
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

    if (!previousChar.match(/[a-z]|\./i)) return;

    // Initiate Completion
    e.preventDefault();
    e.stopPropagation();

    let root = line.substr(0, caret.col);

    let candidates = JSPropertyProvider(this.sb, root);
    if (!candidates) return;

    let offset = this.editor.getCaretOffset();

    // if one candidate
    if (candidates.matches.length == 1) {
      let suffix = candidates.matches[0].substr(candidates.matchProp.length);
      this.editor.setText(suffix, offset, offset);
      return;
    }

    // if several candidate

    let commonPrefix = candidates.matches.reduce(function(commonPrefix, nextValue) {
      if (!commonPrefix)
        return nextValue;

      if (commonPrefix == "")
        return "";

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
