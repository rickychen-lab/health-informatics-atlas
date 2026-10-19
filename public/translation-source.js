// Keep the extraction contract shared by content authoring and coverage checks.
export function splitSentences(text) {
  const value=String(text??'');
  if(!value.trim())return [];
  const parts=[...new Intl.Segmenter('en',{granularity:'sentence'}).segment(value)].map(part=>part.segment);
  // A dotfile is a filename, not a sentence boundary.
  const joined=[];
  for(const part of parts){if(part.startsWith('DS_Store')&&joined.at(-1)?.endsWith('; .'))joined[joined.length-1]+=part;else joined.push(part)}
  return joined.map(part=>part.trim()).filter(Boolean);
}
export function lessonTexts(lesson) {
  return [lesson.summary,...lesson.outcomes,...lesson.sections.flatMap(s=>[s.body,s.example].filter(Boolean)),...lesson.pitfalls,...lesson.mastery,...lesson.quiz.flatMap(q=>[q.question,...q.options,q.explanation]),lesson.exercise.prompt,lesson.exercise.hint,lesson.exercise.solution];
}
export function glossaryTexts(entries){return entries.flatMap(g=>[g.definition,g.example].filter(Boolean))}
export function practicalTexts(data){return data.labs.flatMap(l=>[l.subtitle,...l.steps.flatMap(s=>[s.prompt,s.hint,s.answer]),...l.checks])}
export function courseNoteTexts(data){return (data.notes||[]).map(n=>typeof n==='string'?n:n.title+': '+n.body)}
export function needsTranslation(text){return /[A-Za-z]{2}/.test(text)&&!/^\s*[\u3400-\u9fff]/u.test(text)&&!/^\s*(?:[A-Za-z_]\w*\s*=\s*(?:raw|pd|np)[.\[]|[A-Za-z_]\w*\.(?:to_csv|plot|groupby|copy)\()/u.test(text)}
export function sentencesFrom(texts){return [...new Set(texts.flatMap(splitSentences).filter(needsTranslation))]}
