/** Strict zero-dollar OpenRouter selection. Do not trust manual model slugs or
 * a model's name ending in :free unless the verified catalog agrees.
 */
export function isZeroPriceTextModel(model) {
  if (!model || typeof model.id !== 'string') return false;
  const pricing = model.pricing || {};
  const dimensions = ['prompt','completion','request','image','audio'];
  if (!['prompt','completion'].every((key)=>pricing[key] !== undefined)) return false;
  if (dimensions.some((key) => pricing[key] !== undefined && !(Number.isFinite(Number(pricing[key])) && Number(pricing[key]) === 0))) return false;
  const architecture = model.architecture || {};
  if (Array.isArray(architecture.output_modalities) && !architecture.output_modalities.includes('text')) return false;
  if (architecture.modality && !architecture.modality.includes('text')) return false;
  return true;
}

export function selectFreeChatCandidates(manual, catalog, {maxDiscovered=6}={}) {
  const free = (Array.isArray(catalog)?catalog:[]).filter(isZeroPriceTextModel)
    .sort((a,b)=>(b.context_length||0)-(a.context_length||0));
  const eligible = new Set(free.map(m=>m.id));
  const denied = [...new Set(manual)].filter(name => name!=='openrouter/free' && !eligible.has(name));
  const allowedManual = manual.filter(name => name==='openrouter/free' || eligible.has(name));
  return {
    candidates: [...new Set([...allowedManual,'openrouter/free',...free.slice(0,maxDiscovered).map(m=>m.id)])],
    denied,
    discovered: free.length
  };
}

export const ZERO_PRICE_CEILING = Object.freeze({
  max_price: {prompt:0,completion:0,request:0,image:0,audio:0}
});
