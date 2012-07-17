const Cu = Components.utils;
const Cc = Components.classes;
const Ci = Components.interfaces;

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
            trackedWindows.add(window);
          }
        }, false);
      } else if (aTopic == "domwindowclosed") {
        let window = aSubject.QueryInterface(Ci.nsIDOMWindow);
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

/* ----------- */

let JSTermManager = {
  _map: new WeakMap(),

  addControlsToWindow: function(aWindow) {
    let doc = aWindow.document;
    let button = doc.createElement("toolbarbutton");
    button.setAttribute("label", "JSTerm");
    button.className = "developer-toolbar-button";
    button.id = "developer-toolbar-jsterm";
    button.setAttribute("style", "-moz-image-region: rect(0, 16px, 16px, 0);");
    button.addEventListener("command", function() {
      let browser = aWindow.gBrowser.selectedBrowser;
      this.toggleForBrowser(browser);
    }.bind(this), true);
    let toolbar = doc.querySelector("#developer-toolbar");
    let before = doc.querySelector("#developer-toolbar-webconsole");
    toolbar.insertBefore(button, before);
  },
  removeControlsFromWindow: function(aWindow) {
    let button = aWindow.document.querySelector("#developer-toolbar-jsterm");
    button.parentNode.removeChild(button);
  },
  isOpenForBrowser: function(aBrowser) {
    return this._map.has(aBrowser);
  },
  toggleForBrowser: function(aBrowser) {
    if (this.isOpenForBrowser(aBrowser)) {
      this.closeForBrowser(aBrowser);
    } else {
      this.openForBrowser(aBrowser);
    }
  },
  openForBrowser: function(aBrowser) {
    if (this.isOpenForBrowser(aBrowser))
      return;
    let term = new JSTerm(aBrowser);
    this._map.set(aBrowser, term);
    this.updateCheckboxStatus(aBrowser);
  },
  closeForBrowser: function(aBrowser) {
    let term = this._map.get(aBrowser);
    if (!term)
      return;
    term.destroy();
    this._map.delete(aBrowser);
    this.updateCheckboxStatus(aBrowser);
  },
  updateCheckboxStatus: function(aBrowser) {
  },
}

function JSTerm(aBrowser) {
  this.browser = aBrowser;
  this.chromeDoc = aBrowser.ownerDocument;
  this.chromeWin = this.chromeDoc.defaultView;
  this.buildUI();
}

JSTerm.prototype = {
  buildUI: function() {
    let nbox = this.chromeWin.gBrowser.getNotificationBox(this.browser);
    let doc = this.chromeDoc;

    let splitter = doc.createElement("splitter");
    splitter.className = "devtools-horizontal-splitter jsterm-splitter";

    let container = doc.createElement("vbox");
    container.setAttribute("flex", "1");
    container.className = "jsterm-container";
    container.height = 200;

    let iframe = doc.createElement("iframe");
    iframe.setAttribute("src", "chrome://jsterm/content/jsterm.xul");
    iframe.setAttribute("flex", "1")
    container.appendChild(iframe);
    nbox.appendChild(splitter);
    nbox.appendChild(container);
  },
  destroy: function() {
    let nbox = this.chromeWin.gBrowser.getNotificationBox(this.browser);
    let container = nbox.querySelector(".jsterm-container");
    let splitter = nbox.querySelector(".jsterm-splitter");
    splitter.parentNode.removeChild(splitter);
    container.parentNode.removeChild(container);
    this.browser = null;
    this.chromeDoc = null;
    this.chromeWin = null;
  }
}
