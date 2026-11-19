const button=document.querySelector('#canvasButton');
button.addEventListener('click',async()=>{
  button.disabled=true;
  try {const response=await fetch('/api/canvas/open',{method:'POST'});if(!response.ok)throw Error();}
  catch {alert('创作画布暂时无法打开，请确认画布组件已安装后重试。');}
  finally {button.disabled=false;}
});
