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
