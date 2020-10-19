
// step1.  open media
const openMediaDevice = async(constraints)=>{
        return await navigator.mediaDevices.getUserMedia(constraints);
}

try{
    const streaem = openMediaDevice({'video':true,'audio':true});
    console.log("Got MediaStream",stream);
}catch(error){
    console.error('error accessing media devices.',error);
}


async function getConnectedDevices(type) {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter(device => device.kind === type)
}

const videoCameras = getConnectedDevices('videoinput');
console.log('Cameras found:', videoCameras);

function updateCameraList(cameras) {
    const listElement = document.querySelector('select#availableCameras');
    listElement.innerHTML = '';
    cameras.map(camera => {
        const cameraOption = document.createElement('option');
        cameraOption.label = camera.label;
        cameraOption.value = camera.deviceId;
    }).forEach(cameraOption => listElement.add(cameraOption));
}

const videoCameras = getConnectedDevices('videoinput');
updateCameraList(videoCameras);

// Listen for changes to media devices and update the list accordingly
navigator.mediaDevices.addEventListener('devicechange', event => {
    const newCameraList = getConnectedDevices('video');
    updateCameraList(newCameraList);
});

// Open camera with at least minWidth and minHeight capabilities
async function openCamera(cameraId, minWidth, minHeight) {
    const constraints = {
        'audio': {'echoCancellation': true},
        'video': {
            'deviceId': cameraId,
            'width': {'min': minWidth},
            'height': {'min': minHeight}
            }
        }

    return await navigator.mediaDevices.getUserMedia(constraints);
}

const cameras = getConnectedDevices('videoinput');
if (cameras && cameras.length > 0) {
    // Open first available video camera with a resolution of 1280x720 pixels
    const stream = openCamera(cameras[0].deviceId, 1280, 720);
}

async function playVideoFromCamera() {
    try {
        const constraints = {'video': true, 'audio': true};
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        const videoElement = document.querySelector('video#localVideo');
        videoElement.srcObject = stream;
    } catch(error) {
        console.error('Error opening video camera.', error);
    }
}

const signalingChannel = new SignalingChannel(remoteClientId);
signalingChannel.addEventListener('message', message => {
    // New message from remote client received
});

// Send an asynchronous message to the remote client
signalingChannel.send('Hello!');

//-----------------------------------------------
// webrtc signaling and iceCandiate Connection
//-----------------------------------------------

// signaling listener
async function makeCall(){ 
    self = this;
    self.iceCandiateState="";
    self.pc=null;

    alert("show signals offer"+offer);
    const iceConf={'iceServers':[{'urls': 'stun:stun.l.google.com:19302'}]}
    const peerConnect = new RTCPeerConnection(iceConf);
    signalingChannel.addEventListener('message',async message=>{
        
        if(message.answer){
            const remoteDesc = new RTCSessionDescription(message.answer);
            await peerConnect.setRemoteDescription(remoteDesc);
            const offer = await peerConnect.createOffer();
            await peerConnect.setLocalDescription(offer);
            signalingChannel.send({'offer':offer});
        }

        if(message.offer){
            peerConnect.setRemoteDescription(new RTCSessionDescription(message.offer));
            const answer = await peerConnection.createAnswer();
            await peerConnection.setLocalDescription(answer);
            signalingChannel.send({'answer':anser});
        }

        if(message.iceCandiate){
            try{
                await peerConnect.addIceCandidate(message.iceCandiate);
            }catch(error){
                console.error("error add received ice candiate",error);
            }
        }

    });
    peerConnect.addEventListener('icecandiate',event=>{
            if(event.candiate)
            {
                signalingChannel.send({'new-ice-candiate':event.candiate});
            }
    });
    peerConnect.addEventListener('conectionstatechange',event=>{
        if(peerConnect.connectionstatechange=='connected'){
            console.log("connect finish");
        }
    });
}

