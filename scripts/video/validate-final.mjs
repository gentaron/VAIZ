/** Offline final-media gate before a video can leave VAIZ.
 * Deliberately no network calls, GitHub tokens, model execution or FFmpeg mutation.
 */
import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const defaultPath=path.join(root,'out/final.mp4');

export function rate(value) {
  if (typeof value !== 'string') return NaN;
  const [n,d=1]=value.split('/').map(Number);
  return d > 0 ? n/d : NaN;
}

/**
 * @typedef {{width:number,height:number,pixels:ArrayLike<number>}} RigidityFrame
 */

/**
 * 連続 2 フレームのシーン剛性を局所偏差で測る。副作用・外部通信なし。
 * 整数の平行移動だけを位置合わせで吸収し、スケール変化は吸収しない。
 * 整列後に残ったブロック単位の平均絶対差の RMS を返す (0 = 完全剛性、小さいほど剛性が高い)。
 * 自由なスケール合わせをしないのは、徐々に崩れるシーンを「動いただけ」と
 * 見逃さないため。周辺 maxShift ピクセルは位置合わせ用の共通領域として比較しない。
 *
 * @param {RigidityFrame} prev
 * @param {RigidityFrame} next
 * @param {{maxShift?:number,cell?:number}} [opts]
 * @returns {number}
 */
export function sceneRigidityScore(prev, next, {maxShift=4,cell=4}={}) {
  const w=prev?.width, h=prev?.height;
  if(!Number.isInteger(w)||!Number.isInteger(h)||!Number.isInteger(maxShift)||maxShift<0||
     w<=2*maxShift||h<=2*maxShift||next?.width!==w||next?.height!==h) return NaN;
  const a=prev.pixels, b=next.pixels;
  if(!a||!b||a.length<w*h||b.length<w*h) return NaN;

  const step=Math.max(1,Math.floor(Math.min(w,h)/32));
  let best={dx:0,dy:0,cost:Number.POSITIVE_INFINITY};
  for(let dy=-maxShift;dy<=maxShift;dy++) {
    for(let dx=-maxShift;dx<=maxShift;dx++) {
      let sum=0,n=0;
      for(let y=maxShift;y<h-maxShift;y+=step) {
        for(let x=maxShift;x<w-maxShift;x+=step) {
          sum+=Math.abs(a[y*w+x]-b[(y+dy)*w+x+dx]);
          n++;
        }
      }
      const cost=sum/n;
      const smaller=Math.abs(dx)+Math.abs(dy)<Math.abs(best.dx)+Math.abs(best.dy);
      if(cost<best.cost-1e-9||(Math.abs(cost-best.cost)<=1e-9&&smaller)) best={dx,dy,cost};
    }
  }

  const {dx,dy}=best;
  const bw=Math.max(1,Math.floor((w-2*maxShift)/cell));
  const bh=Math.max(1,Math.floor((h-2*maxShift)/cell));
  let squares=0,blocks=0;
  for(let by=0;by<cell;by++) {
    const y0=maxShift+by*bh, y1=Math.min(h-maxShift,y0+bh);
    for(let bx=0;bx<cell;bx++) {
      const x0=maxShift+bx*bw, x1=Math.min(w-maxShift,x0+bw);
      if(y0>=y1||x0>=x1) continue;
      let sum=0,n=0;
      for(let y=y0;y<y1;y++) {
        for(let x=x0;x<x1;x++) {
          sum+=Math.abs(a[y*w+x]-b[(y+dy)*w+x+dx]);
          n++;
        }
      }
      squares+=(sum/n)**2;
      blocks++;
    }
  }
  return blocks ? Math.sqrt(squares/blocks) : NaN;
}

export function checkFinalMetadata(info, bytes, {minSeconds=10,maxSeconds=240}={}) {
  const errors=[];
  if (!Number.isSafeInteger(bytes) || bytes < 1024) errors.push('media file is missing or too small');
  const streams=Array.isArray(info?.streams)?info.streams:[];
  const videos=streams.filter(s=>s.codec_type==='video');
  const audios=streams.filter(s=>s.codec_type==='audio');
  const video=videos[0];
  if(videos.length!==1) errors.push('expected exactly one video stream');
  if(audios.length!==1) errors.push('expected exactly one audio stream');
  if(video) {
    if(video.codec_name!=='h264') errors.push('video codec must be H.264');
    if(video.pix_fmt!=='yuv420p') errors.push('pixel format must be yuv420p');
    if(video.color_range==='pc') errors.push('color range must be limited (tv)');
    if(video.width!==1080 || video.height!==1920) errors.push('output must be 1080x1920 portrait');
    const fps=rate(video.avg_frame_rate||video.r_frame_rate);
    if(!Number.isFinite(fps)||Math.abs(fps-30)>0.1) errors.push('frame rate must be 30fps');
  }
  if(audios[0]?.codec_name!=='aac') errors.push('audio codec must be AAC');
  const duration=Number(info?.format?.duration);
  if(!Number.isFinite(duration)||duration<minSeconds||duration>maxSeconds)
    errors.push(`duration must be ${minSeconds}-${maxSeconds}s`);
  return {ok:errors.length===0,errors,duration:Number.isFinite(duration)?duration:null,bytes};
}

export function inspectFinal(file=defaultPath) {
  const bytes=statSync(file).size;
  const stdout=execFileSync('ffprobe',[
    '-v','error','-print_format','json','-show_streams','-show_format',file,
  ],{encoding:'utf8',timeout:60000,stdio:['ignore','pipe','pipe']});
  const result=checkFinalMetadata(JSON.parse(stdout),bytes);
  if(!result.ok)throw new Error('Video release gate failed: '+result.errors.join('; '));
  return result;
}

if(import.meta.main) {
  try {
    const result=inspectFinal(process.argv[2]||defaultPath);
    console.log(`Video evidence gate PASS: ${result.duration.toFixed(1)}s, ${result.bytes} bytes, 1080x1920 H.264/AAC`);
  } catch(error) {
    console.error(error.message);
    process.exitCode=1;
  }
}
