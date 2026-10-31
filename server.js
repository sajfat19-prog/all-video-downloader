import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { spawn } from "node:child_process";
import { lookup } from "node:dns/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const app = express();
const root = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
app.use(helmet());
app.use(express.json({ limit: "20kb" }));
app.use(express.static(path.join(root, "public")));
app.use("/api", rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: true, legacyHeaders: false }));

function privateIP(ip) {
  if (net.isIPv4(ip)) {
    const [a,b] = ip.split(".").map(Number);
    return a===10 || a===127 || a===0 || (a===169&&b===254) || (a===172&&b>=16&&b<=31) || (a===192&&b===168) || a>=224;
  }
  if (net.isIPv6(ip)) return ip==="::1" || ip==="::" || /^(fc|fd|fe80)/i.test(ip);
  return true;
}
async function checkedURL(raw) {
  let u;
  try { u = new URL(raw); } catch { throw Error("الرابط غير صالح"); }
  if (!["http:","https:"].includes(u.protocol) || u.username || u.password) throw Error("يسمح بروابط HTTP وHTTPS العامة فقط");
  const records = await lookup(u.hostname, { all: true });
  if (!records.length || records.some(x => privateIP(x.address))) throw Error("هذا العنوان غير مسموح");
  return u.toString();
}
function getInfo(url) {
  return new Promise((resolve,reject) => {
    const p=spawn("yt-dlp",["--dump-single-json","--no-warnings","--no-playlist","--skip-download",url]);
    let out="",err="";
    const timer=setTimeout(()=>{p.kill("SIGKILL");reject(Error("انتهت مهلة تحليل الرابط"));},120000);
    p.stdout.on("data",d=>{out+=d;if(out.length>5_000_000)p.kill("SIGKILL");});
    p.stderr.on("data",d=>{err+=d;});
    p.on("error",e=>{clearTimeout(timer);reject(e);});
    p.on("close",c=>{clearTimeout(timer);if(c===0){try{resolve(JSON.parse(out));}catch{reject(Error("تعذر قراءة معلومات الفيديو"));}}else reject(Error(err.slice(-1000)||"تعذر تحليل الرابط"));});
  });
}
app.post("/api/info",async(req,res)=>{
  try {
    const url=await checkedURL(req.body?.url), d=await getInfo(url);
    res.json({title:d.title||"Video",thumbnail:d.thumbnail||null,duration:d.duration||null,uploader:d.uploader||null,
      formats:(d.formats||[]).filter(f=>f.vcodec!=="none"&&f.height).map(f=>({height:f.height,ext:f.ext})).slice(-25)});
  } catch(e) { res.status(400).json({error:e.message||"حدث خطأ"}); }
});
app.post("/api/download",async(req,res)=>{
  let url;
  try { url=await checkedURL(req.body?.url); } catch(e) { return res.status(400).json({error:e.message}); }
  const audio=req.body?.type==="mp3", q=String(req.body?.quality||"best");
  const args=["--no-playlist","--no-warnings","--no-part","--no-progress","--restrict-filenames","-o","-"];
  if(audio) args.push("-x","--audio-format","mp3","--audio-quality","0");
  else if(q==="best") args.push("-f","bv*+ba/b");
  else {
    const h=Number(q);
    if(![360,480,720,1080,1440,2160].includes(h)) return res.status(400).json({error:"الجودة غير صالحة"});
    args.push("-f",`bv*[height<=${h}]+ba/b[height<=${h}]`);
  }
  args.push(url);
  res.setHeader("Content-Type",audio?"audio/mpeg":"video/mp4");
  res.setHeader("Content-Disposition",`attachment; filename="video.${audio?"mp3":"mp4"}"`);
  const child=spawn("yt-dlp",args,{stdio:["ignore","pipe","ignore"]});
  child.stdout.pipe(res);
  const timer=setTimeout(()=>child.kill("SIGKILL"),Number(process.env.MAX_DOWNLOAD_SECONDS||900)*1000);
  child.on("close",code=>{clearTimeout(timer);if(code!==0&&!res.headersSent)res.status(502).json({error:"تعذر تنزيل الفيديو من هذا المصدر"});else if(!res.writableEnded)res.end();});
  child.on("error",()=>{clearTimeout(timer);if(!res.headersSent)res.status(500).json({error:"تعذر تشغيل خدمة التنزيل"});});
  req.on("close",()=>{if(!res.writableEnded)child.kill("SIGTERM");});
});
app.get("/api/health",(_,res)=>res.json({ok:true}));
app.listen(PORT,"0.0.0.0",()=>console.log("Listening on "+PORT));
