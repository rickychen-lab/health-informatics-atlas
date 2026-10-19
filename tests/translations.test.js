import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {splitSentences,needsTranslation,lessonTexts,glossaryTexts,practicalTexts,courseNoteTexts} from '../public/translation-source.js';
import {setTranslationCatalogue,translatedText,translationToolbar} from '../public/translation.js';
const read=name=>JSON.parse(readFileSync(new URL('../public/'+name+'.json',import.meta.url),'utf8'));
const f=read('foundations'),p=read('privacy'),pr=read('practicals');

test('every learning-body sentence has aligned Chinese while all original English is retained',()=>{
 const catalogue=read('translations');
 setTranslationCatalogue(catalogue);
 const texts=[...f.lessons.flatMap(lessonTexts),...p.lessons.flatMap(lessonTexts),...glossaryTexts([...f.glossary,...p.glossary]),...practicalTexts(pr),...courseNoteTexts(f),...courseNoteTexts(p),...read('translation-ui-source')];
 for(const text of texts){
  const pairs=catalogue[text];
  assert.ok(pairs,`Missing body field: ${text}`);
  assert.deepEqual(pairs.map(([en])=>en),splitSentences(text),`Missing or reordered English: ${text}`);
  for(const [en,zh]of pairs){if(needsTranslation(en))assert.match(zh,/[\u3400-\u9fff]/u,`Missing Chinese: ${en}`)}
  const originalOnly=translatedText(text).replace(/<span class="sentence-zh"[^>]*>.*?<\/span>/gs,'').replace(/<[^>]+>/g,'').replace(/&(amp|lt|gt|quot|#39);/g,(_,entity)=>({amp:'&',lt:'<',gt:'>',quot:'"','#39':"'"}[entity]));
  assert.equal(originalOnly,text,'Rendering must retain original English, code and whitespace exactly');
 }
});

test('translations render as paired language spans and cannot inject markup',()=>{
 setTranslationCatalogue({'Risk < 1%':[['Risk < 1%','风险 < 1%，不是 <script>alert(1)</script>。']]});
 const html=translatedText('Risk < 1%');
 assert.match(html,/lang="en">Risk &lt; 1%/);
 assert.match(html,/class="sentence-zh" lang="zh-CN"/);
 assert.match(html,/&lt;script&gt;/);
 assert.doesNotMatch(html,/<script>/);
});

test('missing or unavailable translations preserve readable original text',()=>{
 assert.equal(setTranslationCatalogue(null),false);
 assert.equal(translatedText('Keep <original> & examples'), 'Keep &lt;original&gt; &amp; examples');
 assert.equal(setTranslationCatalogue({wrong:[['incomplete']]}),false);
 setTranslationCatalogue({'Original. Next.':[['Original.','原文。']]});
 assert.equal(translatedText('Original. Next.'),'Original. Next.');
 const toolbar=translationToolbar(true,false);
 assert.match(toolbar,/aria-pressed="false" disabled/);
 assert.match(toolbar,/Translation unavailable/);
});
