// Approval page for the human. The page itself holds no data and no secret: the admin token is typed
// into the browser, kept in that tab only (or on the device if asked), and sent as a Bearer header.
const CSP = "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const HTML = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>AI relay 承認</title>
<style>
:root{--bg:#f6f7f9;--card:#fff;--fg:#16181d;--muted:#667085;--line:#d9dde3;--ok:#0b7a43;--no:#b42318;--accent:#2f5fd0}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--card:#191c22;--fg:#e8eaee;--muted:#98a2b3;--line:#2c313a;--ok:#3ecf8e;--no:#f97066;--accent:#7aa2ff}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 system-ui,-apple-system,"Hiragino Sans","Noto Sans JP",sans-serif}
main{max-width:720px;margin:0 auto;padding:20px 16px 60px}h1{font-size:20px;margin:8px 0 4px}h2{font-size:15px;margin:28px 0 8px;color:var(--muted);font-weight:600}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px;margin:10px 0}
.meta{color:var(--muted);font-size:13px}.who{font-weight:600}.text{white-space:pre-wrap;word-break:break-word;margin:8px 0}
.tag{display:inline-block;border:1px solid var(--line);border-radius:999px;padding:0 8px;font-size:12px;color:var(--muted);margin-left:6px}
button{font:inherit;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--fg);padding:8px 16px;cursor:pointer}
button.ok{background:var(--ok);border-color:var(--ok);color:#fff}button.no{color:var(--no);border-color:var(--no)}button:disabled{opacity:.5}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:10px}input[type=password]{font:inherit;flex:1;min-width:200px;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--fg)}
details{margin-top:6px}summary{cursor:pointer;color:var(--muted);font-size:13px}pre{white-space:pre-wrap;word-break:break-word;font-size:12px;margin:6px 0 0}
#msg{color:var(--no);font-size:14px;min-height:1.4em}.empty{color:var(--muted)}
</style></head><body><main>
<h1>AI relay 承認</h1><div class="meta">DM送信・投稿・削除・課金にあたる指示は、ここで承認するまで相手のAIに渡りません。</div>
<section id="login" hidden><div class="card"><label for="tok">管理用トークン（ADMIN_TOKEN）</label>
<div class="row"><input id="tok" type="password" autocomplete="off"><button id="go" class="ok">開く</button></div>
<label class="meta"><input id="keep" type="checkbox"> この端末に保存する（自分専用の端末のみ）</label></div></section>
<div id="msg" role="status"></div>
<section id="app" hidden>
<div class="row"><button id="reload">更新</button><button id="out">ログアウト</button><span class="meta" id="stamp"></span></div>
<h2>承認待ち</h2><div id="pending"></div>
<h2>最近のやり取り</h2><div id="recent"></div>
</section></main><script src="admin.js"></script></body></html>`;

const JS = `(function(){
var base=location.pathname.replace(/\\/admin\\/?$/,"");var KEY="relay_admin_token";
var $=function(id){return document.getElementById(id)};
function token(){return sessionStorage.getItem(KEY)||localStorage.getItem(KEY)||""}
function el(tag,cls,text){var e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e}
function api(method,path,body){return fetch(base+path,{method:method,headers:Object.assign({authorization:"Bearer "+token()},body?{"content-type":"application/json"}:{}),body:body?JSON.stringify(body):undefined}).then(function(r){return r.json().then(function(j){return{status:r.status,json:j}})})}
function show(logged){$("login").hidden=logged;$("app").hidden=!logged}
function card(e,pending){var c=el("div","card");var h=el("div");h.appendChild(el("span","who",e.source+" → "+e.target));h.appendChild(el("span","tag",e.type));h.appendChild(el("span","tag",e.status));
if(e.payload&&e.payload.action)h.appendChild(el("span","tag","action: "+e.payload.action));c.appendChild(h);
c.appendChild(el("div","meta",e.created_at.replace("T"," ").replace("+09:00"," JST")));
c.appendChild(el("div","text",(e.payload&&(e.payload.summary||e.payload.text))||"(本文なし)"));
var d=el("details");d.appendChild(el("summary","","詳細（payload全文・ID）"));d.appendChild(el("pre","",JSON.stringify({event_id:e.event_id,correlation_id:e.correlation_id,reply_to:e.reply_to,hop_count:e.hop_count,payload:e.payload},null,2)));c.appendChild(d);
if(pending){var r=el("div","row");var ok=el("button","ok","承認して送る");var no=el("button","no","却下");
var act=function(what){return function(){if(what==="approve"&&!confirm("この指示を "+e.target+" に渡します。よろしいですか？"))return;ok.disabled=no.disabled=true;api("POST","/events/"+e.event_id+"/"+what,{by:"admin page"}).then(function(x){if(x.status!==200)$("msg").textContent="失敗: "+(x.json&&x.json.message||x.status);load()})}};
ok.onclick=act("approve");no.onclick=act("reject");r.appendChild(ok);r.appendChild(no);c.appendChild(r)}return c}
function fill(id,list,pending,empty){var box=$(id);box.textContent="";if(!list.length)box.appendChild(el("div","empty",empty));list.forEach(function(e){box.appendChild(card(e,pending))})}
function load(){$("msg").textContent="";Promise.all([api("GET","/events?status=awaiting_approval"),api("GET","/events")]).then(function(rs){
if(rs[0].status===401){sessionStorage.removeItem(KEY);localStorage.removeItem(KEY);show(false);$("msg").textContent="トークンが違います";return}
if(rs[0].status!==200||rs[1].status!==200){$("msg").textContent="読み込みに失敗しました";return}
show(true);fill("pending",rs[0].json.events,true,"承認待ちはありません");fill("recent",rs[1].json.events.filter(function(e){return e.status!=="awaiting_approval"}).slice(0,15),false,"まだありません");
$("stamp").textContent="更新: "+new Date().toLocaleTimeString()}).catch(function(){$("msg").textContent="通信エラー"})}
$("go").onclick=function(){var v=$("tok").value.trim();if(!v)return;($("keep").checked?localStorage:sessionStorage).setItem(KEY,v);$("tok").value="";load()};
$("tok").onkeydown=function(ev){if(ev.key==="Enter")$("go").click()};
$("reload").onclick=load;$("out").onclick=function(){sessionStorage.removeItem(KEY);localStorage.removeItem(KEY);show(false)};
if(token())load();else show(false);
})();`;

const common = { "cache-control": "no-store", "content-security-policy": CSP, "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "x-frame-options": "DENY" };

export function adminPage(path: string): Response | null {
  if (path === "/admin") return new Response(HTML, { headers: { ...common, "content-type": "text/html; charset=utf-8" } });
  if (path === "/admin.js") return new Response(JS, { headers: { ...common, "content-type": "text/javascript; charset=utf-8" } });
  return null;
}
