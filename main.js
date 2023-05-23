"use strict";

/*
 * Created with @iobroker/create-adapter v2.4.0
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require("@iobroker/adapter-core");
const axios = require("axios").default;
const Json2iob = require("json2iob");
const mqtt = require("mqtt");
const uuid = require("uuid");

class ScheppachRoboticmower extends utils.Adapter {
  /**
   * @param {Partial<utils.AdapterOptions>} [options={}]
   */
  constructor(options) {
    super({
      ...options,
      name: "scheppach-roboticmower",
    });
    this.on("ready", this.onReady.bind(this));
    this.on("stateChange", this.onStateChange.bind(this));
    this.on("unload", this.onUnload.bind(this));
    this.deviceArray = [];
    this.json2iob = new Json2iob(this);
    this.requestClient = axios.create();
    this.mqttClient = null;
    this.clientId = uuid.v4();
  }

  /**
   * Is called when databases are connected and adapter received configuration.
   */
  async onReady() {
    // Reset the connection indicator during startup
    this.setState("info.connection", false, true);

    if (!this.config.username || !this.config.password) {
      this.log.error("Please set username and password in the instance settings");
      return;
    }

    this.updateInterval = null;
    this.reLoginTimeout = null;
    this.refreshTokenTimeout = null;
    this.session = {};
    this.subscribeStates("*");

    this.log.info("Login to Robotic Mower");
    await this.login();
    if (this.session.access_token) {
      await this.getDeviceList();
      await this.updateDevices();
      await this.connectMqtt();
      this.updateInterval = setInterval(async () => {
        await this.updateDevices();
      }, 60 * 60 * 1000);
    }
    this.refreshTokenInterval = setInterval(() => {
      this.refreshToken();
    }, (this.session.expires_in || 3600) * 1000);
  }
  async login() {
    await this.requestClient({
      method: "post",
      maxBodyLength: Infinity,
      url: "http://server.sk-robot.com/api/auth/oauth/token",
      headers: {
        "Accept-Language": "de-de",
        Authorization: "Basic YXBwOmFwcA==",
        "Content-Type": "application/x-www-form-urlencoded",
        Connection: "Keep-Alive",
        "User-Agent": "okhttp/4.4.1",
      },
      data: {
        username: this.config.username,
        password: this.config.password,
        grant_type: "password",
        scope: "server",
      },
    })
      .then((res) => {
        this.log.debug(JSON.stringify(res.data));
        this.setState("info.connection", true, true);
        this.session = res.data;
      })
      .catch((error) => {
        this.log.error("Login failed");
        this.log.error(error);
        error.response && this.log.error(JSON.stringify(error.response.data));
      });
  }
  async connectMqtt() {
    if (this.mqttClient) {
      this.mqttClient.end();
    }

    this.mqttClient = mqtt.connect("mqtt://mqtts.sk-robot.com", {
      username: "app",
      password: "h4ijwkTnyrA",
      clientId: this.clientId,
      keepalive: 60,
      reconnectPeriod: 1000,
      connectTimeout: 30 * 1000,
      will: {
        topic: "None",
        payload: "None",
        qos: 0,
        retain: false,
      },
    });
    this.mqttClient.on("connect", () => {
      this.log.info("MQTT connected");
      this.mqttClient && this.mqttClient.subscribe("/app/" + this.session.user_id + "/get", { qos: 0 });
    });
    this.mqttClient.on("message", (topic, message) => {
      this.log.debug("MQTT message: " + topic + " " + message.toString());
      try {
        const data = JSON.parse(message.toString());
        if (data.deviceSn) {
          this.json2iob.parse(data.deviceSn + ".mqtt", data, { forceIndex: true });
        }
      } catch (error) {
        this.log.error("MQTT message error: " + error);
        this.log.error("MQTT message: " + message.toString());
      }
    });
    this.mqttClient.on("error", (error) => {
      this.log.error("MQTT error: " + error);
    });
    this.mqttClient.on("close", () => {
      this.log.info("MQTT closed");
    });
    this.mqttClient.on("offline", () => {
      this.log.info("MQTT offline");
    });
    this.mqttClient.on("reconnect", () => {
      this.log.info("MQTT reconnect");
    });
  }
  async getDeviceList() {
    await this.requestClient({
      method: "get",
      maxBodyLength: Infinity,
      url: "http://server.sk-robot.com/api/mower/device-user/list",
      headers: {
        "Content-Type": "application/json",
        "Accept-Language": "de-de",
        Authorization: "bearer " + this.session.access_token,
        Host: "server.sk-robot.com",
        Connection: "Keep-Alive",
        "User-Agent": "okhttp/4.4.1",
      },
    })
      .then(async (res) => {
        this.log.debug(JSON.stringify(res.data));
        if (res.data.code !== 0) {
          this.log.error("Error getting device list");
          this.log.error(JSON.stringify(res.data));
          return;
        }

        this.log.info(`Found ${res.data.data.length} devices`);

        for (const device of res.data.data) {
          const id = device.deviceSn;

          this.deviceArray.push(id);
          const name = device.deviceName;

          await this.setObjectNotExistsAsync(id, {
            type: "device",
            common: {
              name: name,
            },
            native: {},
          });
          await this.setObjectNotExistsAsync(id + ".remote", {
            type: "channel",
            common: {
              name: "Remote Controls",
            },
            native: {},
          });

          const remoteArray = [
            { command: "Refresh", name: "True = Refresh" },
            {
              command: "mode",
              name: "1 = Start, 0 = Pause, 2 = Home, 4 = Border",
              type: "string",
              role: "state",
              def: 0,
            },
          ];
          remoteArray.forEach((remote) => {
            this.setObjectNotExists(id + ".remote." + remote.command, {
              type: "state",
              common: {
                name: remote.name || "",
                type: remote.type || "boolean",
                role: remote.role || "button",
                // @ts-ignore
                def: remote.def != null ? remote.def : false,
                write: true,
                read: true,
              },
              native: {},
            });
          });
          await this.setObjectNotExistsAsync(id + ".general", {
            type: "channel",
            common: {
              name: "General Information",
            },
            native: {},
          });
          this.json2iob.parse(id + ".general", device, { forceIndex: true });
          await this.getSettings(id);
          await this.setObjectNotExistsAsync(id + ".mqtt", {
            type: "channel",
            common: {
              name: "Live Mqtt Data",
            },
            native: {},
          });
        }
      })
      .catch((error) => {
        this.log.error(error);
        error.response && this.log.error(JSON.stringify(error.response.data));
      });
  }
  async getSettings(snr) {
    await this.requestClient({
      method: "get",
      maxBodyLength: Infinity,
      url: "http://server.sk-robot.com/api/mower/device-setting/" + snr,
      headers: {
        "Accept-Language": "de-de",
        Authorization: "bearer " + this.session.access_token,
        Host: "server.sk-robot.com",
        Connection: "Keep-Alive",
        "User-Agent": "okhttp/4.4.1",
      },
    })
      .then(async (res) => {
        this.log.debug(JSON.stringify(res.data));
        if (res.data.code !== 0) {
          this.log.error("Error getting device settings");
          this.log.error(JSON.stringify(res.data));
          return;
        }
        await this.setObjectNotExistsAsync(snr + ".settings", {
          type: "channel",
          common: {
            name: "Settings",
          },
          native: {},
        });
        this.json2iob.parse(snr + ".settings", res.data.data, { forceIndex: true });
      })
      .catch((error) => {
        this.log.error(error);
        error.response && this.log.error(JSON.stringify(error.response.data));
      });
  }
  async updateDevices() {
    const statusArray = [
      {
        path: "status",
        url: "http://server.sk-robot.com/api/mower/device/getBysn?sn=$id",
        desc: "Status 1x update per hour",
      },
    ];
    for (const id of this.deviceArray) {
      for (const element of statusArray) {
        const url = element.url.replace("$id", id);

        await this.requestClient({
          method: element.method || "get",
          url: url,
          headers: {
            "Accept-Language": "de-de",
            Authorization: "bearer " + this.session.access_token,
            Host: "server.sk-robot.com",
            Connection: "Keep-Alive",
            "User-Agent": "okhttp/4.4.1",
          },
        })
          .then(async (res) => {
            this.log.debug(JSON.stringify(res.data));
            if (!res.data) {
              return;
            }
            if (res.data.code !== 0) {
              this.log.error(res.data);
              return;
            }
            const data = res.data.data;

            const forceIndex = true;
            const preferedArrayName = null;

            this.json2iob.parse(id + "." + element.path, data, {
              forceIndex: forceIndex,
              write: true,
              preferedArrayName: preferedArrayName,
              channelName: element.desc,
            });
            // await this.setObjectNotExistsAsync(id + '.' + element.path + '.json', {
            //   type: 'state',
            //   common: {
            //     name: 'Raw JSON',
            //     write: false,
            //     read: true,
            //     type: 'string',
            //     role: 'json',
            //   },
            //   native: {},
            // })
            // this.setState(id + '.' + element.path + '.json', JSON.stringify(data), true)
          })
          .catch((error) => {
            if (error.response) {
              if (error.response.status === 401) {
                error.response && this.log.debug(JSON.stringify(error.response.data));
                this.log.info(element.path + " receive 401 error. Refresh Token in 60 seconds");
                this.refreshTokenTimeout && clearTimeout(this.refreshTokenTimeout);
                this.refreshTokenTimeout = setTimeout(() => {
                  this.refreshToken();
                }, 1000 * 60);

                return;
              }
            }
            this.log.error(element.url);
            this.log.error(error);
            error.response && this.log.error(JSON.stringify(error.response.data));
          });
      }
    }
  }

  async refreshToken() {
    this.log.debug("Refresh token");

    await this.requestClient({
      method: "post",
      maxBodyLength: Infinity,
      url: "http://server.sk-robot.com/api/auth/oauth/token",
      headers: {
        "Accept-Language": "de-de",
        Authorization: "Basic YXBwOmFwcA==",
        "Content-Type": "application/x-www-form-urlencoded",
        Host: "server.sk-robot.com",
        Connection: "Keep-Alive",
        "User-Agent": "okhttp/4.4.1",
      },
      data: {
        grant_type: "refresh_token",
        refresh_token: this.session.refresh_token,
        scope: "server",
      },
    })
      .then((res) => {
        this.log.debug(JSON.stringify(res.data));
        this.session = res.data;
        this.log.debug("Refresh successful");
        this.setState("info.connection", true, true);
      })
      .catch(async (error) => {
        this.log.error(error);
        error.response && this.log.error(JSON.stringify(error.response.data));
        this.setStateAsync("info.connection", false, true);
      });
  }

  /**
   * Is called when adapter shuts down - callback has to be called under any circumstances!
   * @param {() => void} callback
   */
  onUnload(callback) {
    try {
      this.setState("info.connection", false, true);
      this.refreshTimeout && clearTimeout(this.refreshTimeout);
      this.reLoginTimeout && clearTimeout(this.reLoginTimeout);
      this.refreshTokenTimeout && clearTimeout(this.refreshTokenTimeout);
      this.updateInterval && clearInterval(this.updateInterval);
      this.refreshTokenInterval && clearInterval(this.refreshTokenInterval);
      callback();
    } catch (e) {
      callback();
    }
  }

  /**
   * Is called if a subscribed state changes
   * @param {string} id
   * @param {ioBroker.State | null | undefined} state
   */
  async onStateChange(id, state) {
    if (state) {
      const deviceId = id.split(".")[2];
      if (!state.ack) {
        const command = id.split(".")[4];

        if (id.split(".")[4] === "Refresh") {
          this.updateDevices();
          return;
        }

        await this.requestClient({
          method: "post",
          url:
            "http://server.sk-robot.com/api/mower/device/setWorkStatus/" +
            deviceId +
            "/" +
            this.session.user_id +
            "?" +
            command +
            "=" +
            state.val,
          headers: {
            "Accept-Language": "de-de",
            Authorization: "bearer " + this.session.access_token,
            "Content-Type": "application/json",
            Host: "server.sk-robot.com",
            Connection: "Keep-Alive",
            "User-Agent": "okhttp/4.4.1",
          },
        })
          .then((res) => {
            this.log.info(JSON.stringify(res.data));
          })
          .catch(async (error) => {
            this.log.error(error);
            error.response && this.log.error(JSON.stringify(error.response.data));
          });
        this.refreshTimeout = setTimeout(async () => {
          this.log.info("Update devices");
          await this.updateDevices();
        }, 10 * 1000);
      } else {
        if (id.indexOf(".workStatusCode") !== -1 || id.indexOf("mqtt.mode") !== -1) {
          this.setState(deviceId + ".remote.mode", state.val, true);
        }
      }
    }
  }
}
if (require.main !== module) {
  // Export the constructor in compact mode
  /**
   * @param {Partial<utils.AdapterOptions>} [options={}]
   */
  module.exports = (options) => new ScheppachRoboticmower(options);
} else {
  // otherwise start the instance directly
  new ScheppachRoboticmower();
}
