(function(global, sdkClass) {
  global = global || self;
  global.MgSdk = new sdkClass();
})(this, function() {
  "use strict";
  let self = this;

  self.connect = function(service, uri, token, stream, displayName) {
    let conn = new MgConnection(service, uri, token, stream, displayName);
    console.log(uri, token);
    setTimeout(async function() {
      await conn.connect();
    }, 0);

    return conn;
  };

  self.setVideoStream = function(selector, stream) {
    let elem = document.querySelector(selector);
    if (elem != null) {
      // don't set srcObject again if it is already set.
      // if (elem.srcObject && stream) {
      // 	return;
      // }
      elem.srcObject = stream;
    }
  };

  self.getVideoTrack = function(stream) {
    try {
      if (!stream) {
        return null;
      }

      let tracks = stream.getVideoTracks();
      if (!tracks) {
        return null;
      }

      let track = tracks[0];
      if (!track) {
        return null;
      }

      return track;
    } catch (e) {
      return null;
    }
  };

  self.getAudioTrack = function(stream) {
    try {
      if (!stream) {
        return null;
      }

      let tracks = stream.getAudioTracks();
      if (!tracks) {
        return null;
      }

      let track = tracks[0];
      if (!track) {
        return null;
      }

      return track;
    } catch (e) {
      return null;
    }
  };

  self.isStreamVideoEnabled = function(stream) {
    let track = self.getVideoTrack(stream);
    if (track == null) {
      return false;
    }

    return track.enabled;
  };

  self.isStreamAudioEnabled = function(stream) {
    let track = self.getAudioTrack(stream);
    if (track == null) {
      return false;
    }

    return track.enabled;
  };

  self.enableStreamVideo = function(stream, enabled) {
    let track = self.getVideoTrack(stream);
    if (track == null) {
      return;
    }

    track.enabled = enabled;
  };

  self.enableStreamAudio = function(stream, enabled) {
    let track = self.getAudioTrack(stream);
    if (track == null) {
      return;
    }

    track.enabled = enabled;
  };

  self.getUserMedia = async function(width, height) {
    try {
      const constraints = {
        audio: true,
        video: {
          mandatory: {
            minWidth: width,
            minHeight: height,
            maxWidth: width,
            maxHeight: height,
            minFrameRate: 15,
            maxFrameRate: 30
          }
        }
      };
      let stream = await navigator.mediaDevices.getUserMedia(constraints);

      return stream;
    } catch (err) {
      console.error(err);
      return null;
    }
  };

  self.getDisplayMedia = async function(maxWidth, maxHeight) {
    try {
      const constraints = {
        video: {
          mandatory: {
            maxWidth: maxWidth,
            maxHeight: maxHeight
            // "maxFrameRate": 30,
          }
          // cursor: "always",
        },
        audio: false
        // audio: {
        // 	// echoCancellation: true,
        // 	// noiseSuppression: true,
        // },
      };
      let stream = await navigator.mediaDevices.getDisplayMedia(constraints);

      return stream;
    } catch (err) {
      console.error(err);
      return null;
    }
  };

  function isAsyncFunc(fn) {
    return fn.constructor.name === "AsyncFunction";
  }

  function MgConnection(service, uri, token, stream, displayName) {
    let self = this;

    self.service = service;
    self.uri = uri;
    self.token = token;
    self.stream = stream;
    self.displayName = displayName;
    self.signalingState = "";
    self.iceConnectionState = "";
    self.ws = null;
    self.pc = null;

    self.connect = async function() {
      let wsUrl = self.uri + "?access_token=" + self.token;

      let offerOptions = {
        offerToReceiveAudio: self.service != "spTx",
        offerToReceiveVideo: self.service != "spTx"
      };

      self.ws = await connectWebSocket(
        wsUrl,
        self.stream,
        offerOptions,
        self.displayName
      );
    };

    self.close = function() {
      try {
        if (self.ws) {
          self.ws.close();
        }
        if (self.pc) {
          self.pc.close();
        }
      } catch (err) {
        console.error(err);
      }
    };

    //=========================================================================
    // event
    //=========================================================================
    self.onopen = () => {
      // console.log("onopen");
    };

    self.onclose = () => {
      // console.log("onclose");
      // setRemoteVideo(null);
    };

    // self.onsignalingstatechange = async (evt) => {
    //   // console.log("onsignalingstatechange", pc.signalingState);
    // };

    // self.oniceconnectionstatechange = async (evt) => {
    //   // console.log("oniceconnectionstatechange", pc.iceConnectionState);
    // };

    // self.ontrack = (evt) => {
    //   // console.log("ontrack");
    //   // setRemoteVideo(evt.streams[0]);
    // };

    // self.onlayout = (connId, layout) => {
    //   // console.log("onlayout");
    // };

    //=========================================================================
    // webrtc
    //=========================================================================
    function connectWebSocket(url, stream, offerOptions, displayName) {
      let ws = new WebSocket(url);
      var pc = null;
      var timer = null;

      ws.onopen = async () => {
        console.log("ws onopen");
        if (isAsyncFunc(self.onopen)) {
          await self.onopen();
        } else {
          self.onopen();
        }

        pc = await createPeerConnection(ws, stream, offerOptions, displayName);
        self.pc = pc;

        timer = setInterval(() => {
          ws.send("{}");
        }, 5000);
      };

      ws.onclose = async () => {
        console.log("ws onclose");
        if (timer != null) {
          clearInterval(timer);
        }
        if (pc != null) {
          pc.close();
        }

        if (isAsyncFunc(self.onclose)) {
          await self.onclose();
        } else {
          self.onclose();
        }
      };

      ws.onerror = evt => {
        console.log("ws onerror:", evt);
        if (timer != null) {
          clearInterval(timer);
        }
      };

      ws.onmessage = async evt => {
        console.log("ws onmessage:", evt);
        try {
          let msg = JSON.parse(evt.data);
          // console.log('ws msg:', msg);
          let description;
          switch (msg.method) {
            case "answer":
              description = new RTCSessionDescription(msg.description);
              // console.log('description:', description);
              await pc.setRemoteDescription(description);
              break;

            case "layout":
              delete msg["method"];
              msg.layout = JSON.parse(msg.layout);
              if (isAsyncFunc(self.ontrack)) {
                await self.onlayout(msg);
              } else {
                self.onlayout(msg);
              }
              break;

            default:
              break;
          }
        } catch (err) {
          console.error(err);
        }
      };

      return ws;
    }

    async function createPeerConnection(ws, stream, offerOptions, displayName) {
      const configuration = { iceServers: [] };
      const pc = new RTCPeerConnection(configuration);
      var offerSent = false;

      pc.onicecandidate = async ({ candidate }) => {
        console.log("onicecandidate", candidate);
        try {
          if (candidate == null) {
            return;
          }

          // ws.send(JSON.stringify({candidate: candidate}));
        } catch (err) {
          console.error(err);
        }
      };

      pc.onicegatheringstatechange = async () => {
        console.log("onicegatheringstatechange", pc.iceGatheringState);
        switch (pc.iceGatheringState) {
          case "gathering":
            break;

          case "complete":
            if (offerSent) {
              return;
            }

            try {
              ws.send(
                JSON.stringify({
                  method: "offer",
                  displayName: displayName,
                  description: pc.localDescription
                })
              );
              offerSent = true;
            } catch (err) {
              console.error(err);
            }

            break;
        }
      };

      pc.onconnectionstatechange = async () => {
        console.log("onconnectionstatechange", pc.connectionState);
      };

      pc.onsignalingstatechange = async evt => {
        // console.log("onsignalingstatechange", pc.signalingState);
        self.signalingState = pc.signalingState;
        if (isAsyncFunc(self.onsignalingstatechange)) {
          await self.onsignalingstatechange(evt);
        } else {
          self.onsignalingstatechange(evt);
        }
      };

      pc.oniceconnectionstatechange = async evt => {
        // console.log("oniceconnectionstatechange", pc.iceConnectionState);
        self.iceConnectionState = pc.iceConnectionState;
        if (isAsyncFunc(self.oniceconnectionstatechange)) {
          await self.oniceconnectionstatechange(evt);
        } else {
          self.oniceconnectionstatechange(evt);
        }
      };

      pc.ontrack = async evt => {
        // console.log("ontrack");
        if (isAsyncFunc(self.ontrack)) {
          await self.ontrack(evt);
        } else {
          self.ontrack(evt);
        }
      };

      if (stream != null) {
        // let the "negotiationneeded" event trigger offer generation
        pc.onnegotiationneeded = async () => {
          console.log("onnegotiationneeded");
          if (pc.localDescription) {
            return;
          }

          try {
            let description = await pc.createOffer(offerOptions);
            await pc.setLocalDescription(description);
          } catch (err) {
            console.error(err);
          }
        };

        stream.getTracks().forEach(track => pc.addTrack(track, stream));
      } else {
        try {
          let description = await pc.createOffer(offerOptions);
          await pc.setLocalDescription(description);
        } catch (err) {
          console.error(err);
        }
      }

      return pc;
    }
  }
});
