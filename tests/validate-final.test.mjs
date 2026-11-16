import {describe,test,expect} from 'bun:test';
import {checkFinalMetadata,rate} from '../scripts/video/validate-final.mjs';
const valid={
  format:{duration:'49.82'},
  streams:[
    {codec_type:'video',codec_name:'h264',pix_fmt:'yuv420p',width:1080,height:1920,avg_frame_rate:'30/1'},
    {codec_type:'audio',codec_name:'aac',sample_rate:'24000'}
  ],
};
describe('offline media release evidence gate',()=>{
  test('accepts the expected real renderer metadata shape',()=>{
    expect(checkFinalMetadata(valid,2000000).ok).toBe(true);
    expect(rate('30000/1000')).toBe(30);
  });
  test('rejects silent, wrong-shape, and invalid-codec video',()=>{
    for (const meta of [
      {...valid,streams:[valid.streams[0]]},
      {...valid,streams:[{...valid.streams[0],width:1920,height:1080},valid.streams[1]]},
      {...valid,streams:[{...valid.streams[0],codec_name:'hevc'},valid.streams[1]]},
      {...valid,streams:[{...valid.streams[0],pix_fmt:'yuv444p'},valid.streams[1]]},
      {...valid,streams:[{...valid.streams[0],avg_frame_rate:'24/1'},valid.streams[1]]},
    ]) expect(checkFinalMetadata(meta,2000000).ok).toBe(false);
  });
  test('rejects empty files and pathological duration',()=>{
    expect(checkFinalMetadata(valid,4).ok).toBe(false);
    expect(checkFinalMetadata({...valid,format:{duration:'NaN'}},2000000).ok).toBe(false);
    expect(checkFinalMetadata({...valid,format:{duration:'9000'}},2000000).ok).toBe(false);
  });
});
