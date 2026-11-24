// One-line, action-first sentence for a city card. It is the day screen's
// own decision (advice-rules.js decideDay) said in a few words, so the card
// and the day screen can never disagree.
import { cardSentence } from './advice-rules.js';
export function cardAction(p){
  if(!p)return '';
  return cardSentence(p);
}
