(function(){
 'use strict';
 const $=s=>document.querySelector(s),esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const cats={site:'革命遗址',museum:'纪念场馆',person:'人物',event:'事件',doc:'文献',image:'影像'};
 const dialog=document.createElement('dialog');dialog.className='pub-modal';dialog.setAttribute('aria-labelledby','pub-title');document.body.appendChild(dialog);
 let lastFocus=null;
 function toast(t){$('.pub-toast')?.remove();const e=document.createElement('div');e.className='pub-toast';e.role='status';e.textContent=t;document.body.appendChild(e);setTimeout(()=>e.remove(),4200)}
 function show(title,html){lastFocus=document.activeElement;dialog.innerHTML=`<header><h2 id="pub-title">${esc(title)}</h2><button class="pub-close" aria-label="关闭窗口">×</button></header><div class="pub-body">${html}</div>`;if(!dialog.open)dialog.showModal();$('.pub-close').onclick=()=>dialog.close()}
 dialog.addEventListener('close',()=>lastFocus?.focus());
 const offline=document.createElement('div');offline.className='pub-offline';offline.textContent='当前离线 · 可阅读已缓存内容，收藏与进度保存在此浏览器';offline.hidden=navigator.onLine;document.body.prepend(offline);window.addEventListener('offline',()=>offline.hidden=false);window.addEventListener('online',()=>offline.hidden=true);
 function mount(){
   const home=$('#exHomeWrap');if(home&&!$('.pub-utility')){const row=document.createElement('div');row.className='pub-utility';row.innerHTML='<strong>红色记忆 · 公开体验版</strong><div class="pub-tools"><button class="pub-btn" data-public="records">我的参观</button><button class="pub-btn" data-public="install">添加到桌面</button><button class="pub-btn" data-public="share">分享</button></div>';home.prepend(row)}
   document.querySelectorAll('.a-card[data-aid]').forEach(card=>{if(card.querySelector('.pub-card-save'))return;const id=card.dataset.aid,b=document.createElement('button');b.className='pub-card-save';b.dataset.save=id;b.textContent=publicAPI.state?.favorites.includes(id)?'已收藏 · 取消':'收藏这段记忆';b.setAttribute('aria-label',b.textContent+' '+(card.querySelector('h3')?.textContent||''));card.appendChild(b)});
 }
 let scheduled=false;new MutationObserver(()=>{if(!scheduled){scheduled=true;requestAnimationFrame(()=>{scheduled=false;mount()})}}).observe(document.body,{childList:true,subtree:true});mount();
 function refreshButtons(){document.querySelectorAll('[data-save]').forEach(b=>{b.textContent=publicAPI.state?.favorites.includes(b.dataset.save)?'已收藏 · 取消':'收藏这段记忆';b.removeAttribute('aria-label')})}
 window.publicReady.then(refreshButtons);
 async function records(){
   show('我的参观','<p>正在读取观展记录…</p>');await window.publicReady;
   const state=publicAPI.state,progress=publicAPI.progress(),p=Object.values(progress)[0],favorites=state?.favorites||[];
   let rows=[];try{const b=JSON.parse($('#rgEmbeddedData').textContent);rows=b.atlas.items.filter(r=>favorites.includes(r.id))}catch{}
   show('我的参观',`<p>无需注册即可参观。收藏和进度只保存在当前浏览器；换设备或清除网站数据后不会自动找回。</p><div class="pub-record"><div class="pub-stat"><b>${p?.visited?.length||0} / 5</b><span>已浏览章节</span></div><div class="pub-stat"><b>${favorites.length}</b><span>收藏的记忆</span></div></div><p role="status">${esc(window.publicSyncStatus||'正在连接')}</p><button class="pub-btn" data-public="continue">${p?.last?'继续上次参观':'开始参观'} →</button><button class="pub-btn secondary" data-public="clear">清除观展记录</button><h3>我的收藏</h3><div class="pub-list">${rows.length?rows.map(r=>`<div class="pub-item"><div><strong>${esc(r.name)}</strong><small>${esc(cats[r.cat])} · ${esc(r.place||'红色记忆')}</small><p>${esc((r.summary||'').slice(0,130))}</p></div><button class="pub-btn secondary" data-save="${esc(r.id)}">取消收藏</button></div>`).join(''):'<p class="pub-empty">在「红色记忆总库」点击收藏，<br>把感兴趣的故事留在这里。</p>'}</div><button class="pub-btn" data-public="library">去总库发现更多 →</button>`);
 }
 document.addEventListener('click',async e=>{
   const save=e.target.closest('[data-save]');
   if(save){e.stopPropagation();save.disabled=true;try{await publicAPI.favorite(save.dataset.save,!publicAPI.state?.favorites.includes(save.dataset.save));refreshButtons();toast('收藏已保存');if(dialog.open)await records()}catch(err){toast(err.message)}finally{save.disabled=false}return}
   const b=e.target.closest('[data-public]');if(!b)return;
   switch(b.dataset.public){
    case'records':await records();break;
    case'continue':{dialog.close();const p=Object.values(publicAPI.progress())[0];window.RgExhibit?.openChapter(p?.last||'ch-01');break}
    case'library':dialog.close();$('#viewSeg [data-view="atlas"]')?.click();break;
    case'clear':localStorage.removeItem('rg.exhibition.progress.v1');toast('观展记录已清除');await records();break;
    case'install':if(window.RgInstall?.standalone()){toast('你正在应用窗口中使用');break}if(window.RgInstall?.prompt())break;show('把红色记忆留在桌面','<p>电脑：使用支持安装的 Edge 或 Chrome 打开本站，选择浏览器地址栏的安装图标，或菜单中的「应用／安装此网站」。</p><p>iPhone / iPad：在 Safari 中打开，点击「分享」，选择「添加到主屏幕」。</p><p>Android：在支持安装的浏览器菜单中选择「安装应用」或「添加到主屏幕」。</p><p>安装能力随浏览器而异；校园网等普通 HTTP 地址可浏览，但安装通常需要正式 HTTPS 地址。本机 localhost 可用于开发测试。</p><p>第一次在线打开后会缓存页面和基础展览素材；离线时可浏览已缓存内容，收藏与进度在本浏览器保存；全国在线 AI 需联网，按全站共享额度使用。</p>');break;
    case'share':{const url=location.origin+location.pathname+location.hash;if(['localhost','127.0.0.1'].includes(location.hostname)){show('分享给更多人','<p>当前是本机体验地址，其他人的手机不能通过这个地址访问。</p><p>正式部署并绑定 HTTPS 地址后，就可以分享链接或二维码。当前先体验完整功能。</p>');break}try{if(navigator.share)await navigator.share({title:'红色记忆',url});else{await navigator.clipboard.writeText(url);toast('链接已复制')}}catch{}break}
   }
 },true);
})();
