(() => {
  const roots=[document], controls=[];
  for(let i=0;i<roots.length;i++) for(const e of roots[i].querySelectorAll('*')) {
    if(e.shadowRoot) roots.push(e.shadowRoot);
    if(e.matches('input,textarea,select,[contenteditable=true]')) {
      const sensitive=e.matches('input[type=password],input[type=file],[autocomplete=one-time-code]');
      controls.push([e.tagName,e.getAttribute('name'),sensitive?'[redacted]':(e.value??e.innerText??''),e.checked??null]);
    }
  }
  return {url:location.href,timeOrigin:performance.timeOrigin,title:document.title,
    text:(document.body?.innerText||'').slice(0,16000), controls,
    scroll:[scrollX,scrollY], viewport:[innerWidth,innerHeight], ready:document.readyState};
})()
