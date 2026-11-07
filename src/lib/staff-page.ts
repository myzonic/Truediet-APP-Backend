/**
 * The dietitian's chat page, rendered by this server at /staff.
 *
 * Members message from the app; the dietitian answers here (or with any API
 * client) using the DIETITIAN_API_KEY sent as x-dietitian-key. Same origin as
 * the API, so no CORS setup. The key lives in this browser's localStorage
 * only - never in markup, never on the server.
 *
 * No external assets, no trackers.
 */

const STAFF_CSS = [
  "body{margin:0;background:#F4F8F7;font-family:Helvetica,Arial,sans-serif;color:#1B2A2A}",
  ".wrap{max-width:880px;margin:0 auto;padding:24px 16px 60px}",
  ".brand{font-size:12px;letter-spacing:2px;font-weight:700;color:#0B6B5B;text-transform:uppercase;margin:6px 0 4px}",
  "h1{font-size:26px;line-height:1.25;margin:0 0 6px;color:#0B3B36}",
  ".sub{font-size:14px;line-height:1.6;color:#33413F;margin:0 0 20px}",
  ".card{background:#fff;border:1px solid #DCE7E4;border-radius:16px;padding:18px;margin-bottom:16px}",
  "label{display:block;font-size:13px;font-weight:700;color:#0B3B36;margin:0 0 8px}",
  "input,textarea{width:100%;box-sizing:border-box;font-size:15px;padding:12px 13px;border:1px solid #C9D7D4;border-radius:11px;background:#fff;color:#1B2A2A;font-family:inherit}",
  "input:focus,textarea:focus{outline:none;border-color:#0B6B5B}",
  "textarea{min-height:84px;resize:vertical}",
  ".row{display:flex;gap:10px;align-items:center}",
  "button{padding:12px 18px;border:0;border-radius:11px;background:#0B3B36;color:#fff;font-size:14px;font-weight:700;cursor:pointer}",
  "button:disabled{opacity:.5;cursor:not-allowed}",
  "button.ghost{background:#fff;color:#0B6B5B;border:1px solid #0B6B5B}",
  ".err{display:none;margin-top:12px;padding:12px;border-radius:11px;background:#FDECEC;border:1px solid #F2C4C4;color:#8E1B1B;font-size:14px}",
  ".ok{display:none;margin-top:12px;padding:12px;border-radius:11px;background:#E7F6EE;border:1px solid #BFE6CE;color:#136C43;font-size:14px}",
  ".thread{display:flex;justify-content:space-between;gap:12px;align-items:center;padding:14px 4px;border-bottom:1px solid #E7EEEC;cursor:pointer}",
  ".thread:last-child{border-bottom:0}",
  ".thread:hover{background:#F7FBFA}",
  ".tName{font-size:15px;font-weight:700;color:#0B3B36}",
  ".tMeta{font-size:13px;color:#6B7C7A;margin-top:3px}",
  ".tTime{font-size:12px;color:#6B7C7A;white-space:nowrap}",
  ".bubbles{display:flex;flex-direction:column;gap:10px;margin:4px 0 16px;max-height:440px;overflow-y:auto}",
  ".bub{max-width:78%;padding:12px 14px;border-radius:14px;font-size:15px;line-height:1.5}",
  ".bub.member{background:#EDF5F3;border:1px solid #DCE7E4;align-self:flex-start}",
  ".bub.mine{background:#0B3B36;color:#fff;align-self:flex-end}",
  ".bubMeta{font-size:11px;letter-spacing:.6px;text-transform:uppercase;opacity:.75;margin-bottom:5px;font-weight:700}",
  ".empty{font-size:14px;color:#6B7C7A;padding:12px 4px}",
  ".hint{font-size:12px;color:#6B7C7A;line-height:1.6;margin-top:18px;border-top:1px solid #E7EEEC;padding-top:14px}",
  ".hidden{display:none!important}",
].join("");

const STAFF_JS = [
  "var keyEl=document.getElementById('k'),saveEl=document.getElementById('save'),",
  "errEl=document.getElementById('e'),listEl=document.getElementById('list'),",
  "detailEl=document.getElementById('detail'),titleEl=document.getElementById('dt'),",
  "bubblesEl=document.getElementById('b'),draftEl=document.getElementById('d'),",
  "sendEl=document.getElementById('send'),backEl=document.getElementById('back'),",
  "refreshEl=document.getElementById('refresh');",
  "var current=null,poll=null;",
  "function key(){return (localStorage.getItem('truediet.staffKey')||'').trim();}",
  "function show(msg,ok){errEl.textContent=msg||'';errEl.className=msg?(ok?'ok':'err'):'';}",
  "function api(path,method,body){",
  "  return fetch(path,{method:method||'GET',headers:{'Content-Type':'application/json','x-dietitian-key':key()},body:body?JSON.stringify(body):undefined}).then(function(r){",
  "    return r.json().then(function(j){if(!r.ok)throw new Error(j&&j.message?('('+r.status+') '+j.message):('Request failed ('+r.status+')'));return j;});",
  "  });",
  "}",
  "function fmt(iso){try{return new Date(iso).toLocaleString('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});}catch(e){return iso;}}",
  "function loadThreads(){",
  "  if(!key()){show('Enter your dietitian key to load conversations.');return;}",
  "  show('');listEl.innerHTML='<div class=\"empty\">Loading…</div>';",
  "  api('/api/messages/threads').then(function(data){",
  "    var rows=data.threads||[];",
  "    if(!rows.length){listEl.innerHTML='<div class=\"empty\">No member conversations yet.</div>';return;}",
  "    listEl.innerHTML='';",
  "    rows.forEach(function(t){",
  "      var el=document.createElement('div');el.className='thread';",
  "      el.innerHTML='<div><div class=\"tName\"></div><div class=\"tMeta\"></div></div><div class=\"tTime\"></div>';",
  "      el.querySelector('.tName').textContent=t.memberName||'Member';",
  "      el.querySelector('.tMeta').textContent=t.memberEmail||t.userId;",
  "      el.querySelector('.tTime').textContent=fmt(t.lastMessageAt);",
  "      el.onclick=function(){openThread(t);};",
  "      listEl.appendChild(el);",
  "    });",
  "  }).catch(function(e){listEl.innerHTML='';show(e.message);});",
  "}",
  "function openThread(t){",
  "  current=t;detailEl.classList.remove('hidden');listEl.parentNode.classList.add('hidden');refreshEl.classList.add('hidden');",
  "  titleEl.textContent=(t.memberName||'Member')+' - '+(t.memberEmail||'');",
  "  loadMessages();",
  "  if(poll)clearInterval(poll);poll=setInterval(loadMessages,10000);",
  "}",
  "function loadMessages(){",
  "  if(!current)return;",
  "  api('/api/messages/threads/'+current.id).then(function(data){",
  "    var msgs=data.messages||[];",
  "    if(!msgs.length){bubblesEl.innerHTML='<div class=\"empty\">No messages yet.</div>';return;}",
  "    bubblesEl.innerHTML='';",
  "    msgs.forEach(function(m){",
  "      var el=document.createElement('div');",
  "      var mine=m.authorType==='dietitian';",
  "      el.className='bub '+(mine?'mine':'member');",
  "      el.innerHTML='<div class=\"bubMeta\"></div><div class=\"txt\"></div>';",
  "      el.querySelector('.bubMeta').textContent=mine?'You':(m.authorType==='user'?'Member':m.authorType);",
  "      el.querySelector('.txt').textContent=m.body;",
  "      bubblesEl.appendChild(el);",
  "    });",
  "    bubblesEl.scrollTop=bubblesEl.scrollHeight;",
  "  }).catch(function(e){show(e.message);});",
  "}",
  "function send(){",
  "  var body=draftEl.value.trim();",
  "  if(!body||!current)return;",
  "  sendEl.disabled=true;show('');",
  "  api('/api/messages','POST',{threadId:current.id,body:body}).then(function(){",
  "    draftEl.value='';loadMessages();",
  "  }).catch(function(e){show(e.message);}).finally(function(){sendEl.disabled=false;});",
  "}",
  "function back(){",
  "  if(poll){clearInterval(poll);poll=null;}",
  "  current=null;detailEl.classList.add('hidden');listEl.parentNode.classList.remove('hidden');refreshEl.classList.remove('hidden');loadThreads();",
  "}",
  "saveEl.onclick=function(){",
  "  localStorage.setItem('truediet.staffKey',keyEl.value.trim());",
  "  loadThreads();",
  "};",
  "refreshEl.onclick=loadThreads;",
  "backEl.onclick=back;",
  "sendEl.onclick=send;",
  "draftEl.addEventListener('keydown',function(ev){if(ev.key==='Enter'&&(ev.metaKey||ev.ctrlKey))send();});",
  "keyEl.value=key();",
  "if(key())loadThreads();",
].join("");

export const STAFF_PAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>True Diet - Member Messages</title>
<style>${STAFF_CSS}</style>
</head>
<body>
<div class="wrap">
  <div class="brand">True Diet</div>
  <h1>Member messages</h1>
  <p class="sub">Replies sent here appear in the member's app conversation. The key is stored in this browser only.</p>

  <div class="card">
    <label for="k">Dietitian key</label>
    <div class="row">
      <input id="k" type="password" placeholder="DIETITIAN_API_KEY value" autocomplete="off">
      <button id="save" type="button">Connect</button>
      <button id="refresh" class="ghost hidden" type="button">Refresh</button>
    </div>
    <div id="e" class="err"></div>
  </div>

  <div class="card">
    <div id="list"><div class="empty">Enter your key to load conversations.</div></div>

    <div id="detail" class="hidden">
      <div class="row" style="justify-content:space-between;margin-bottom:10px">
        <div id="dt" class="tName"></div>
        <button id="back" class="ghost" type="button">All conversations</button>
      </div>
      <div id="b" class="bubbles"></div>
      <label for="d">Your reply</label>
      <textarea id="d" placeholder="Write a reply..."></textarea>
      <div class="row" style="margin-top:10px;justify-content:flex-end">
        <button id="send" type="button">Send reply</button>
      </div>
    </div>
  </div>

  <p class="hint">For education and support - not urgent or emergency care. Conversations are stored in the member database and are visible to the member on every device.</p>
</div>
<script>${STAFF_JS}</script>
</body>
</html>`;
