class PortConnector {
  constructor({
    portName = "simcheck",
    customMessageHandler = null,
    replayLastMessage = false,
  } = {}) {
    this.portName = portName;
    this.port = null;
    this.isConnected = false;

    // Use the custom message handler if provided, otherwise use the default one
    this.messageHandler = customMessageHandler || this.defaultMessageHandler;

    this.keepAliveInterval = null;
    this.connect();

    if (replayLastMessage) {
      this.replayLastMessage();
    }
  }

  // Recovers status after a reload mid-operation: background.js caches its
  // last broadcast message under chrome.storage.local["lastMessage"], since
  // a page that (re)connects late would otherwise never see it.
  replayLastMessage() {
    chrome.storage.local.get("lastMessage", (result) => {
      if (chrome.runtime.lastError || result.lastMessage === undefined) {
        return;
      }
      this.messageHandler(result.lastMessage);
      chrome.storage.local.remove("lastMessage", () => {
        if (chrome.runtime.lastError) {
          console.error(
            "Error deleting message:",
            chrome.runtime.lastError.message,
          );
        }
      });
    });
  }

  connect() {
    this.port = chrome.runtime.connect({ name: this.portName });

    // Handle incoming messages
    this.port.onMessage.addListener(this.messageHandler.bind(this));

    // Handle disconnections
    this.port.onDisconnect.addListener(this.handleDisconnect.bind(this));

    this.isConnected = true;

    // Bind the keepAlive method to the current instance
    //this.keepAliveInterval = setInterval(this.keepAlive.bind(this), 5000);
  }

  keepAlive() {
    if (!this.isConnected) {
      console.log("keepAlive attempting to reconnect...");
      this.connect();
    }

    if (this.isConnected) {
      this.postMessage({ action: "ping" });
    } else {
      console.warn("Unable to send keepAlive ping. Port is not connected.");
    }
  }

  disconnect() {
    if (this.port) {
      this.port.disconnect();
      this.port = null;
      this.isConnected = false;
    }
  }

  async defaultMessageHandler(message) {
    console.log(message);
  }

  handleDisconnect() {
    console.log("Disconnected");
    this.isConnected = false;
  }

  isPortConnected() {
    return this.isConnected;
  }

  postMessage(message) {
    if (!this.isConnected) {
      this.connect();
    }

    if (this.port) {
      this.port.postMessage(message);
    } else {
      this.connect();
      if (this.port) {
        this.port.postMessage(message);
      } else {
        console.warn("Unable to send message. Port is not connected.");
      }
    }
  }
}

export { PortConnector };
