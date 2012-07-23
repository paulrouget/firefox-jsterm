const Cu = Components.utils;
const Cc = Components.classes;
const Ci = Components.interfaces;

Cu.import("resource://gre/modules/Services.jsm");
//Cu.import("resource://jsterm/modules/JSTermManager.jsm");

let trackedWindows;
let wObserver;

function startup() {
  function isBrowserWindow(aWindow) {
    let winType = aWindow.document.documentElement.getAttribute("windowtype");
    return winType === "navigator:browser";
  }

  wObserver = {
    observe: function(aSubject, aTopic, aData) {
      if (aTopic == "domwindowopened") {
        let window = aSubject.QueryInterface(Ci.nsIDOMWindow);
        window.addEventListener("load", function winWatcherLoad() {
          window.removeEventListener("load", winWatcherLoad, false);
          if (isBrowserWindow(window)) {
            JSTermManager.addControlsToWindow(window);
            JSTermManager.trackTabs(window);
            trackedWindows.add(window);
          }
        }, false);
      } else if (aTopic == "domwindowclosed") {
        let window = aSubject.QueryInterface(Ci.nsIDOMWindow);
        JSTermManager.untrackTabs(window);
        trackedWindows.delete(window);
      }
    },
  }

  let wWatcher = Cc["@mozilla.org/embedcomp/window-watcher;1"].getService(Ci.nsIWindowWatcher);
  let winEnum = wWatcher.getWindowEnumerator();
  wWatcher.registerNotification(wObserver);

  trackedWindows = new Set();

  let winEnum = wWatcher.getWindowEnumerator();
  while (winEnum.hasMoreElements()) {
    let window = winEnum.getNext().QueryInterface(Ci.nsIDOMWindow);
    if (isBrowserWindow(window)) {
      JSTermManager.addControlsToWindow(window);
      JSTermManager.trackTabs(window);
      trackedWindows.add(window);
    }
  }
}

function shutdown() {
  let wWatcher = Cc["@mozilla.org/embedcomp/window-watcher;1"].getService(Ci.nsIWindowWatcher);
  wWatcher.unregisterNotification(wObserver);
  let winEnum = wWatcher.getWindowEnumerator();
  while (winEnum.hasMoreElements()) {
    let window = winEnum.getNext().QueryInterface(Ci.nsIDOMWindow);
    if (trackedWindows && trackedWindows.has(window)) {
      JSTermManager.removeControlsFromWindow(window);
      JSTermManager.untrackTabs(window);
      for (let b of window.gBrowser.browsers) {
        JSTermManager.closeForBrowser(b);
      }
    }
  }
  trackedWindows = null;
  wObserver = null;
}

function install() {}
function uninstall() {}

/* ***** resource **** */

let JSTermManager = {
  _map: new WeakMap(),
  _listeners: new WeakMap(),
  where: "in_browser",

  addControlsToWindow: function(aWindow) {
    let strings = Services.strings.createBundle("chrome://jsterm/locale/jsterm.properties");

    let doc = aWindow.document;

    aWindow.JSTermManager = this;

    let command = doc.createElement("command");
    command.id = "Tools:JSTerm";
    command.setAttribute("oncommand", "JSTermManager.toggleForBrowser(this)");
    doc.querySelector("#mainCommandSet").appendChild(command);

    let broadcaster = doc.createElement("broadcaster");
    broadcaster.id = "devtoolsMenuBroadcaster_JSTerm";
    broadcaster.setAttribute("label", strings.GetStringFromName("JSTerm.menu.label"));
    broadcaster.setAttribute("type", "checkbox");
    broadcaster.setAttribute("autocheck", "false");
    broadcaster.setAttribute("key", "key_JSTerm");
    broadcaster.setAttribute("command", "Tools:JSTerm");
    doc.querySelector("#mainBroadcasterSet").appendChild(broadcaster);

    let menubaritem = doc.createElement("menuitem");
    menubaritem.classList.add("jsterm-addon");
    menubaritem.id = "menu_JSTerm";
    menubaritem.setAttribute("observes", "devtoolsMenuBroadcaster_JSTerm");
    let webConsoleMenu = doc.querySelector("#webConsole");
    doc.querySelector("#menuWebDeveloperPopup").insertBefore(menubaritem, webConsoleMenu);

    let appmenuPopup = doc.querySelector("#appmenu_webDeveloper_popup");
    if (appmenuPopup) { // no appmenu on Mac
      let appmenuitem = doc.createElement("menuitem");
      appmenuitem.classList.add("jsterm-addon");
      appmenuitem.id = "appmenu_JSTerm";
      appmenuitem.setAttribute("observes", "devtoolsMenuBroadcaster_JSTerm");
      let webConsoleAppMenu = doc.querySelector("#appmenu_webConsole");
      appmenuPopup.insertBefore(appmenuitem, webConsoleAppMenu);
    }

    let key = doc.createElement("key");
    key.classList.add("jsterm-addon");
    key.id = "key_JSTerm";
    key.setAttribute("key", strings.GetStringFromName("JSTerm.key"));
    key.setAttribute("command", "Tools:JSTerm");
    key.setAttribute("modifiers", "accel,alt")
    doc.querySelector("#mainKeyset").appendChild(key);

    let button = doc.createElement("toolbarbutton");
    button.setAttribute("observes", "devtoolsMenuBroadcaster_JSTerm");
    button.classList.add("developer-toolbar-button");
    button.classList.add("jsterm-addon");
    button.id = "developer-toolbar-jsterm";
    button.setAttribute("style", "-moz-image-region: rect(0, 16px, 16px, 0);");
    let before = doc.querySelector("#developer-toolbar-webconsole");
    doc.querySelector("#developer-toolbar").insertBefore(button, before);
  },
  removeControlsFromWindow: function(aWindow) {
    let elts = aWindow.document.querySelectorAll(".jsterm-addon,#devtoolsMenuBroadcaster_JSTerm");
    for (let e of elts) {
      try{
        e.parentNode.removeChild(e);
      }catch(e){}
    }
    let cmd = aWindow.document.getElementById("Tools:JSTerm");
    cmd.parentNode.removeChild(cmd);
  },
  trackTabs: function(aWindow) {
    let tabs = aWindow.gBrowser.tabContainer;
    let update = this.updateCheckboxStatus.bind(this, aWindow);
    tabs.addEventListener("TabSelect", update, true);
    this._listeners.set(aWindow, update);
    aWindow.addEventListener("unload", function onClose(aEvent) {
      tabs.removeEventListener("TabSelect", update, true);
      aWindow.removeEventListener("unload", onClose, false);
    }, false);
  },
  untrackTabs: function(aWindow) {
    let update = this._listeners.get(aWindow);
    if (update) {
      let tabs = aWindow.gBrowser.tabContainer;
      this._listeners.delete(aWindow);
      tabs.removeEventListener("TabSelect", update, true);
    }
  },
  isOpenForBrowser: function(aBrowser) {
    return this._map.has(aBrowser);
  },
  toggleForBrowser: function(aTarget) {
    let browser = aTarget.ownerDocument.defaultView.gBrowser.selectedBrowser;
    if (this.isOpenForBrowser(browser)) {
      this.closeForBrowser(browser);
    } else {
      this.openForBrowser(browser);
    }
  },
  openForBrowser: function(aBrowser) {
    if (this.isOpenForBrowser(aBrowser))
      return;
    let term = new JSTerm(aBrowser);
    this._map.set(aBrowser, term);
    this.updateCheckboxStatus(aBrowser.ownerDocument.defaultView);
  },
  closeForBrowser: function(aBrowser) {
    JSTermGlobalHistory.saveToPref();
    let term = this._map.get(aBrowser);
    if (!term)
      return;
    term.destroy();
    this._map.delete(aBrowser);
    this.updateCheckboxStatus(aBrowser.ownerDocument.defaultView);
  },
  moveTermTo: function(aBrowser, aWhere) {
    this.where = aWhere;
    let term = this._map.get(aBrowser);
    if (!term)
      return;
    term.rebuildUI();
  },

  isTermDocked: function(aBrowser) {
    let term = this._map.get(aBrowser);
    return term.docked;
  },

  updateCheckboxStatus: function(aWindow) {
    let selectedBrowser = aWindow.gBrowser.selectedBrowser;
    let checked = this.isOpenForBrowser(selectedBrowser);
    let broadcaster = aWindow.document.querySelector("#devtoolsMenuBroadcaster_JSTerm");
    if (checked)
      broadcaster.setAttribute("checked", "true");
    else
      broadcaster.setAttribute("checked", "false");
  },
}

function JSTerm(aBrowser) {
  this.browser = aBrowser;
  this.chromeDoc = aBrowser.ownerDocument;
  this.chromeWin = this.chromeDoc.defaultView;
  this.buildUI();
  this.savedContent = null;
}

JSTerm.prototype = {
  buildUI: function() {
    const CHROME_URL = "chrome://jsterm/content/jsterm.xul";
    const CHROME_WINDOW_FLAGS = "chrome,centerscreen,resizable,dialog=no";

    let termWindow;
    let doc = this.chromeDoc;

    this.docked = (JSTermManager.where == "in_browser");

    if (this.docked) {
      let nbox = this.chromeWin.gBrowser.getNotificationBox(this.browser);
      let splitter = doc.createElement("splitter");
      splitter.className = "devtools-horizontal-splitter jsterm-splitter";

      let container = doc.createElement("vbox");
      container.setAttribute("flex", "1");
      container.className = "jsterm-container";
      container.height = 200;

      let iframe = doc.createElement("iframe");
      iframe.setAttribute("src", CHROME_URL);
      iframe.setAttribute("flex", "1")

      container.appendChild(iframe);
      nbox.appendChild(splitter);
      nbox.appendChild(container);

      termWindow = iframe.contentWindow;
    } else {
      termWindow = Services.ww.openWindow(null, CHROME_URL, "_blank", CHROME_WINDOW_FLAGS, {});
    }

    termWindow.onload = function() {
      termWindow.JSTermUI.init(JSTermManager,
                               JSTermGlobalHistory,
                               this.browser,
                               this.browser.contentWindow,
                               this.chromeWin,
                               this.savedContent);
    }.bind(this);

    this.termWindow = termWindow;
  },

  rebuildUI: function() {
    this.savedContent = this.termWindow.JSTermUI.getContent();
    this.destroyUI();
    this.buildUI();
  },

  destroyUI: function() {
    let nbox = this.chromeWin.gBrowser.getNotificationBox(this.browser);
    let container = nbox.querySelector(".jsterm-container");
    if (container) {
      let splitter = nbox.querySelector(".jsterm-splitter");
      splitter.parentNode.removeChild(splitter);
      container.parentNode.removeChild(container);
    } else {
      this.termWindow.close()
    }
  },

  destroy: function() {
    this.destroyUI();
    this.termWindow = null;
    this.browser = null;
    this.chromeDoc = null;
    this.chromeWin = null;
  }
}


let JSTermGlobalHistory = {
  _limit: 5,
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
