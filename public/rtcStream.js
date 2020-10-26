//-----------------------------------------------
// webrtc signaling and iceCandiate Connection
//-----------------------------------------------
const joinBtn = document.querySelector('.joinBtn');
const remoteVideo = document.querySelector('#remoteVideo');
let pc;
const socket = io('http://192.168.1.22:8009');

function createPeerConnection(){
    const iceCon = {
            iceServers:[{
                urls:'stun:stun.l.google.com:19302'
            }]
    };
    pc = new RTCPeerConnection(iceCon);
};

function addLocalStream(localStream){
    pc.addStream(localStream);
};

function joinRoom(){
    socket.emit('joinRoom','secret room');
};
joinBtn.addEventListener('click', joinRoom);

//監聽 ICE Server
function onIceCandidates(){
    // search ice candidate before  send a candidate to server.
    pc.onIceCandidates = ({ candiate})=>{
        if(!candiate){return;}
        console.log('onIceCandidate => ', candidate);
        socket.emit("peerconnectSignaling", { candidate });
    };
};
// listen ice connect status
function onIcecadidateStateChange(){
    pc.oniceconnectionstatechange =(evt)=>{
        console.log('ICE 伺服器狀態變更 => ', evt.target.iceConnectionState);
    };
}
//listen stram can run, if yes then display video
function onAddStream(){
    pc.onaddstream = (evt) => {
        if(!remoteVideo.srcObject && evt.stream){
            remoteVideo.srcObject = evt.stream;
            console.log('接收流並顯示於遠端視訊！', evt);
     };
    };
};


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

