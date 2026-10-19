const escapeHTML=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
let catalogue=Object.create(null);
export function setTranslationCatalogue(data){
  catalogue=Object.create(null);
  if(!data||typeof data!=='object'||Array.isArray(data))return false;
  for(const [source,pairs]of Object.entries(data)){
    if(Array.isArray(pairs)&&pairs.length&&pairs.every(p=>Array.isArray(p)&&p.length===2&&p.every(v=>typeof v==='string'))){
      catalogue[source]=pairs;
    }
  }
  return Object.keys(catalogue).length>0;
}
export function translatedText(value){
  const text=String(value??''),pairs=catalogue[text];
  if(!pairs)return escapeHTML(text);
  let cursor=0;
  const rendered=[];
  for(const [en,zh] of pairs){
    const position=text.indexOf(en,cursor);
    // Ignore a stale/misaligned catalogue rather than changing the source text.
    if(position<0||text.slice(cursor,position).trim())return escapeHTML(text);
    rendered.push(escapeHTML(text.slice(cursor,position)));
    rendered.push(`<span class="sentence-pair"><span class="sentence-en" lang="en">${escapeHTML(en)}</span>${zh?`<span class="sentence-zh" lang="zh-CN">${escapeHTML(zh)}</span>`:''}</span>`);
    cursor=position+en.length;
  }
  if(text.slice(cursor).trim())return escapeHTML(text);
  return `<span class="translated-text">${rendered.join('')}${escapeHTML(text.slice(cursor))}</span>`;
}
export function translationToolbar(enabled,available=true){
  return `<div class="reading-tools"><div><span class="reading-tools-label">EN / 中文</span><span class="reading-tools-caption">${available?'Read sentence by sentence · <span lang="zh-CN">英中逐句对照</span>':'Translation unavailable · 翻译暂未载入，请刷新'}</span></div><button class="language-button reading-toggle" lang="zh-CN" data-translation-toggle aria-pressed="${!!(enabled&&available)}" ${available?'':'disabled'}>逐句翻译 <span lang="en">${enabled&&available?'On':'Off'}</span></button></div>`;
}
