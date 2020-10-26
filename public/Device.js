let localStream;
let videoTrack;
let audioTrack;

const constraints={
    audio:true,
    video: { 
        width: 1280, 
        height: 720,
       frameRate:{
           ideal:15,max:60
       }
    }
};

async function createMedia(){

  await window.navigator.mediaDevices.getUserMedia(constraints).then(function(stream){
//finish get device
var video = document.querySelector('#myVideo');
if("srcObject" in video){
    video.srcObject = stream;
    localStream = stream;
    videoTrack = stream.getVideoTracks();
    console.log(`usage video device => ${videoTrack[0].label}`);
    audioTrack = stream.getAudioTracks();
    console.log(`usage audio device => ${audioTrack[0].label}`)
}
else {
    video.src = window.URL.createObjectURL(stream);
}
video.onloadedmetadata=function(e){video.play();};
}).catch(function(err){
    //error to get device 
    console.error("[Device] can't find device");
});

}