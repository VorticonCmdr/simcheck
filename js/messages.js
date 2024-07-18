class PortConnector {
  constructor({ portName = "simcheck", customMessageHandler = null } = {}) {
    this.portName = portName;
    this.port = null;
    this.isConnected = false;

    // Use the custom message handler if provided, otherwise use the default one
    this.messageHandler = customMessageHandler || this.defaultMessageHandler;

    this.keepAliveInterval = null;
    this.connect();
  }

  connect() {
    this.port = chrome.runtime.connect({ name: this.portName });

    // Handle incoming messages
    this.port.onMessage.addListener(this.messageHandler.bind(this));

    // Handle disconnections
    this.port.onDisconnect.addListener(this.handleDisconnect.bind(this));

    this.isConnected = true;

    // Bind the keepAlive method to the current instance
    this.keepAliveInterval = setInterval(this.keepAlive.bind(this), 5000);
  }

  keepAlive() {
    this.postMessage({ action: "ping" });
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
    console.log(this.port);
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
