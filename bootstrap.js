const Cu = Components.utils;
const Cc = Components.classes;
const Ci = Components.interfaces;

Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource:///modules/devtools/gDevTools.jsm");

let manifest = {
  id: "jsterm",
  label: "JSTerm",
  url: "chrome://jsterm/content/jsterm.xul",
  build: function(aIFrameWindow, aTarget) {
    dump("BUILD\n");
    return new JSTerm(aIFrameWindow, aTarget);
  },
};

function startup() {
  dump("REGISTER: " + gDevTools + "\n");
  gDevTools.registerTool(manifest);
}

function shutdown() {
  gDevTools.unregisterTool(manifest.id);
}

function install() {}
function uninstall() {}

/* ***** resource **** */

function JSTerm(aIFrameWindow, aTarget) {
  aIFrameWindow.JSTermUI.init(JSTermGlobalHistory, aTarget);
}

JSTerm.prototype = {
  destroy: function(){},
}


let JSTermGlobalHistory = {
  _limit: 100, // Should be a pref
  _entries: [],

  _cut: function() {
    let newStart = this._entries.length - this._limit;
    if (newStart <= 0) return;

    this._entries = this._entries.slice(newStart);

    for (let cursor of this._cursors) {
      if (cursor) {
        cursor.idx -= newStart;
        cursor.origin -= newStart;
      }
    }
  },

  add: function(aEntry) {
    if (!aEntry) {
      return;
    }
    if (this._entries.length) {
      let lastEntry = this._entries[this._entries.length - 1];
      if (lastEntry == aEntry)
        return;
    }
    this._entries.push(aEntry);

    if (this._entries.length > this._limit) {
      this._cut();
    }
  },

  initFromPref: function() {
    let history = [];

    // Try to load history from pref
    if (Services.prefs.prefHasUserValue("devtools.jsterm.history")) {
      try {
        history = JSON.parse(Services.prefs.getCharPref("devtools.jsterm.history"));
      } catch(e) {
        // User pref is malformated.
        Cu.reportError("Could not parse pref `devtools.jsterm.history`: " + e);
      }
    }

    if (Array.isArray(history)) {
      this._entries = history;
    } else {
      Cu.reportError("History (devtools.jsterm.history) is malformated.");
      this._entries = [];
    }
  },

  saveToPref: function() {
    Services.prefs.setCharPref("devtools.jsterm.history", JSON.stringify(this._entries));
  },

  _cursors: [],
  getCursor: function(aInitialValue) {
    let cursor = {idx: this._entries.length,
                  origin: this._entries.length,
                  initialEntry: aInitialValue};
    this._cursors.push(cursor);
    return cursor;
  },

  releaseCursor: function(cursor) {
      this._cursors[cursor.idx] = null;
  },

  getEntryForCursor: function(cursor) {
    if (cursor.idx < 0) {
      return "";
    } else if (cursor.idx < cursor.origin) {
      return this._entries[cursor.idx];
    } else {
      return cursor.initialEntry;
    }
  },

  canGoBack: function(cursor) {
    return (cursor.idx > 0)
  },

  canGoForward: function(cursor) {
    return (cursor.idx < cursor.origin);
  },

  goBack: function(cursor) {
    if (this.canGoBack(cursor)) {
      cursor.idx--;
      return true;
    } else {
      return false;
    }
  },

  goForward: function(cursor) {
    if (this.canGoForward(cursor)) {
      cursor.idx++;
      return true;
    } else {
      return false;
    }
  },
}
JSTermGlobalHistory.initFromPref();
