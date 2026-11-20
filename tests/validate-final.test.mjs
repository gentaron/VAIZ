import {describe,test,expect} from 'bun:test';
import {checkFinalMetadata,rate,sceneRigidityScore} from '../scripts/video/validate-final.mjs';
const valid={
  format:{duration:'49.82'},
  streams:[
    {codec_type:'video',codec_name:'h264',pix_fmt:'yuv420p',color_range:'tv',width:1080,height:1920,avg_frame_rate:'30/1'},
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
      {...valid,streams:[{...valid.streams[0],pix_fmt:'yuvj420p',color_range:'pc'},valid.streams[1]]},
      {...valid,streams:[{...valid.streams[0],color_range:'pc'},valid.streams[1]]},
      {...valid,streams:[{...valid.streams[0],avg_frame_rate:'24/1'},valid.streams[1]]},
    ]) expect(checkFinalMetadata(meta,2000000).ok).toBe(false);
  });
  test('rejects empty files and pathological duration',()=>{
    expect(checkFinalMetadata(valid,4).ok).toBe(false);
    expect(checkFinalMetadata({...valid,format:{duration:'NaN'}},2000000).ok).toBe(false);
    expect(checkFinalMetadata({...valid,format:{duration:'9000'}},2000000).ok).toBe(false);
  });
});

describe('sceneRigidityScore',()=>{
  test('平行移動だけなら偏差ゼロ、局所変形ありは残る (素の差分と順位が逆転する)',()=>{
    const w=40,h=32;
    const base=new Uint8Array(w*h);
    for(let y=0;y<h;y++) for(let x=0;x<w;x++)
      base[y*w+x]=(x*29+y*17+((x>>2)^(y>>2))*43)%256;
    const frame=(pixels)=>({width:w,height:h,pixels});
    const moved=new Uint8Array(w*h);
    for(let y=0;y<h;y++) for(let x=0;x<w;x++) {
      const ox=x-3, oy=y+2;
      moved[y*w+x]=ox>=0&&ox<w&&oy>=0&&oy<h?base[oy*w+ox]:0;
    }
    const warped=new Uint8Array(base);
    for(let y=4;y<26;y++) for(let x=8;x<24;x++)
      warped[y*w+x]=base[(y+Math.floor((x-8)/3))*w+x];

    const raw=(pixels)=>{
      let sum=0;
      for(let y=4;y<h-4;y++) for(let x=4;x<w-4;x++) sum+=Math.abs(base[y*w+x]-pixels[y*w+x]);
      return sum;
    };
    expect(raw(moved)).toBeGreaterThan(raw(warped));
    const rigid=sceneRigidityScore(frame(base),frame(moved));
    const broken=sceneRigidityScore(frame(base),frame(warped));
    expect(rigid).toBe(0);
    expect(rigid).toBeLessThan(broken);
  });
});
