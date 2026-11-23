// One-line, action-first sentence for a city card. Deliberately tiny:
// the full prose engine (advice-rules.js) stays on the day screen; cards
// only need "what do I do?" from fields parse() already returns.
// Order matters: the first matching rule wins (safety → rain → wind → temperature → sun).
export function cardAction(p){
  if(!p)return '';
  const code=p.tCode,rain=Number.isFinite(p.maxRain)?p.maxRain:0;
  const feels=Number.isFinite(p.feels)?p.feels:p.nowTemp;
  const evening=p.slots?.find(s=>s.label==='evening')?.temp;
  const daytime=p.band==='MORNING'||p.band==='DAY';
  if(code>=95)return 'Stay in if you can.';
  if((code>=71&&code<=77)||code===85||code===86)return 'Watch your step.';
  if(code===66||code===67)return 'Mind the ice.';
  if(rain>=60||(code>=61&&code<=65)||(code>=80&&code<=82))return 'Take an umbrella.';
  if(rain>=40||(code>=51&&code<=57))return 'Keep an umbrella close.';
  if(p.wind>=40)return 'Hold onto your hat.';
  if(feels<=0)return 'Wear your warmest coat.';
  if(daytime&&Number.isFinite(evening)&&feels-evening>=6&&evening<=14)return 'Jacket for tonight.';
  if(feels<=8)return 'Pack your jacket.';
  if(feels<=15)return 'Bring a light jacket.';
  if(feels>=28)return 'Stay cool, drink water.';
  if(p.uvIndex>=6&&daytime)return 'Wear sunscreen.';
  if(feels>=22)return 'T-shirt weather.';
  return 'Nothing special needed.';
}
