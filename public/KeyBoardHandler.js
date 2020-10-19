// get mouse
 function getMousePos(event){
     
        var e = event || window.event;
        var scrollX = document.documentElement.scrollLeft || document.body.scrollLeft;
        var scrollY = document.documentElement.scrollTop || document.body.scrollTop;
        var x = e.x ;
        var y = e.pageY ;
        return { 'x': x, 'y': y };
    }
function test(e){ 
    document.getElementById("mjs").innerHTML = getMousePos(e).x +','+ getMousePos(e).y;   
    messageInputBox = document.getElementById('message');
    messageInputBox.value = document.getElementById('mjs').innerHTML;
    }

    function startup() {
        connectButton = document.getElementById('connectButton');
        disconnectButton = document.getElementById('disconnectButton');
        sendButton = document.getElementById('sendButton');
        messageInputBox = document.getElementById('message');
        receiveBox = document.getElementById('receivebox');
      
        // Set event listeners for user interface widgets
      
        connectButton.addEventListener('click', connectPeers, false);
        disconnectButton.addEventListener('click', disconnectPeers, false);
        sendButton.addEventListener('click', sendMessage, false);
      }
      function connectPeers(){
            alert("trigger");
      }
      function disconnectPeers(){

      }
      function sendMessage(){

      }