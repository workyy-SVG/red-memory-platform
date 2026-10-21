(function(){'use strict';
const progressKey='rg.exhibition.progress.v1',favoritesKey='rm.static.favorites.v1';
function read(key,fallback){try{return JSON.parse(localStorage.getItem(key)||'null')||fallback}catch{return fallback}}
const state={favorites:read(favoritesKey,[])};
window.publicSyncStatus='收藏与进度保存在此浏览器，清除网站数据后会丢失';
window.publicVisitor=state;window.publicReady=Promise.resolve(state);
window.publicAPI={get state(){return state},progress:()=>read(progressKey,{}),connect:async()=>state,request:async()=>{throw Error('免费展示版没有管理接口')},async favorite(id,enabled){const next=state.favorites.filter(x=>x!==id);if(enabled)next.push(id);localStorage.setItem(favoritesKey,JSON.stringify(next));state.favorites=next;return state}};
})();
