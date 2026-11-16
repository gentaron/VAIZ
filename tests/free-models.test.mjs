import {describe,test,expect} from 'bun:test';
import {isZeroPriceTextModel,selectFreeChatCandidates,ZERO_PRICE_CEILING} from '../scripts/video/free-models.mjs';

const free={id:'test/free:free',context_length:32000,pricing:{prompt:'0',completion:'0'},architecture:{modality:'text->text'}};
const paid={id:'test/paid',pricing:{prompt:'0.0001',completion:'0'},architecture:{modality:'text->text'}};
describe('zero-budget OpenRouter selection',()=>{
  test('only catalog-confirmed free models or free router can be called',()=>{
    const result=selectFreeChatCandidates(['test/paid','test/free:free','unknown/model'],[free,paid]);
    expect(result.candidates).toEqual(['test/free:free','openrouter/free']);
    expect(result.denied).toEqual(['test/paid','unknown/model']);
  });
  test('no catalog: only openrouter/free; no unverifiable manual models',()=>{
    const result=selectFreeChatCandidates(['test/paid'],[]);
    expect(result.candidates).toEqual(['openrouter/free']);
  });
  test('rejects request or modality fees hidden behind zero token pricing',()=>{
    expect(isZeroPriceTextModel({...free,pricing:{...free.pricing,request:'0.01'}})).toBe(false);
    expect(isZeroPriceTextModel({...free,pricing:{...free.pricing,image:'0.01'}})).toBe(false);
    expect(isZeroPriceTextModel({...free,pricing:{prompt:'unknown',completion:'0'}})).toBe(false);
    expect(isZeroPriceTextModel(free)).toBe(true);
    expect(ZERO_PRICE_CEILING.max_price.request).toBe(0);
  });
});
