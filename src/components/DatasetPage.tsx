import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import { cacheFile, deleteCachedFiles, getCachedFile } from '../imageCache'
import type { PromptVaultItem } from './PromptVaultPage'

export interface DatasetSourceItem { id:string; prompt?:string; url?:string; createdAt?:number }
type Img={filename:string;mimeType:string;data:string}
type Item={prompt:string;images:Img[]}
type Dataset={version:number;createdAt?:string;items:Item[]}
type Ref={id:string;filename:string;mimeType:string;cacheKey:string}
export type PageItem=PromptVaultItem
type Page={id:string;name:string;createdAt:string;items:PageItem[]}
const KEY='comfyui-console-datasets-v1'
const makeId=(p:string)=>p+'_'+Date.now()+'_'+Math.random().toString(36).slice(2,9)
const read=():Page[]=>{try{const x=JSON.parse(localStorage.getItem(KEY)||'[]');return Array.isArray(x)?x:[]}catch{return[]}}
const b64=(b:Blob)=>new Promise<string>((ok,no)=>{const r=new FileReader();r.onloadend=()=>ok(r.result as string);r.onerror=no;r.readAsDataURL(b)})
const download=async(name:string,json:string)=>{const blob=new Blob([json],{type:'application/json'});const file=new File([blob],name,{type:'application/json'});const nav=navigator as Navigator&{share?:((data:ShareData)=>Promise<void>);canShare?:((data:ShareData)=>boolean)};const mobile=/iPhone|iPad|iPod|Android/i.test(navigator.userAgent)||(/Macintosh/i.test(navigator.userAgent)&&navigator.maxTouchPoints>1);if(mobile&&typeof nav.share==='function'&&(!nav.canShare||nav.canShare({files:[file]}))){try{await nav.share({files:[file],title:name});return}catch(error){if(error instanceof DOMException&&error.name==='AbortError')return}}const u=URL.createObjectURL(blob);const a=document.createElement('a');a.href=u;a.download=name;a.rel='noopener';document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(u),60000)}
const validate=(x:any):Dataset=>{if(!x||typeof x!=='object'||!Array.isArray(x.items))throw new Error(!x||typeof x!=='object'?'Invalid JSON object':'Missing or invalid items array');for(const i of x.items){i.prompt=i.prompt==null?'':typeof i.prompt==='string'?i.prompt:String(i.prompt);if(!Array.isArray(i.images))i.images=[];i.images=i.images.filter((v:any)=>v&&typeof v.data==='string'&&v.data.startsWith('data:'))}return x as Dataset}
function Cached({keyId}:{keyId:string}){const[u,setU]=useState('');useEffect(()=>{let o='';let live=true;void getCachedFile(keyId).then(b=>{if(live&&b){o=URL.createObjectURL(b);setU(o)}});return()=>{live=false;if(o)URL.revokeObjectURL(o)}},[keyId]);return u?<img src={u} alt="" loading="lazy"/>:<div className="dataset-image-empty"><span className="dataset-inline-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9" r="1.5"/><path d="m4 18 5-5 4 4 2-2 5 5"/></svg></span></div>}

export function DatasetPage({onClose,onMoveToVault}:{onClose:()=>void;sourceItems:DatasetSourceItem[];onMoveToVault?:(items:PageItem[])=>void;onRestoreHistory?:(items:Item[])=>Promise<void>}){
 const[pages,setPages]=useState<Page[]>(read),[active,setActive]=useState<string|null>(()=>read()[0]?.id||null)
 const[step,setStep]=useState<'idle'|'upload'|'preview'|'importing'|'complete'>('idle'),[data,setData]=useState<Dataset|null>(null),[err,setErr]=useState(''),[progress,setProgress]=useState([0,0]),[summary,setSummary]=useState<number[]>([])
 const[viewer,setViewer]=useState<PageItem|null>(null),[vaultSel,setVaultSel]=useState<Set<string>>(new Set()),[opts,setOpts]=useState({images:true,prompts:true,dupes:'skip' as 'skip'|'all'}),input=useRef<HTMLInputElement>(null)
 useEffect(()=>localStorage.setItem(KEY,JSON.stringify(pages)),[pages])
 const page=pages.find(x=>x.id===active)||null
 const reset=()=>{setStep('idle');setData(null);setErr('');setSummary([])}
 const upload=(e:ChangeEvent<HTMLInputElement>)=>{const f=e.target.files?.[0];if(!f)return;const r=new FileReader();r.onload=z=>{try{setData(validate(JSON.parse(z.target?.result as string)));setErr('');setStep('preview')}catch(e){setErr(e instanceof Error?e.message:'Failed to parse JSON file.')}};r.readAsText(f);e.target.value=''}
 const doImport=async()=>{if(!data)return;setStep('importing');const count=pages.filter(p=>p.name.startsWith('Imported')).length,name=count?'Imported '+(count+1):'Imported',items:PageItem[]=[];let ip=0,ii=0,sd=0,ir=0;for(let n=0;n<data.items.length;n++){const src=data.items[n];if(opts.dupes==='skip'&&src.prompt&&items.some(x=>x.prompt===src.prompt)){sd++;setProgress([n+1,data.items.length]);continue}try{const refs:Ref[]=[];if(opts.images)for(const im of src.images){const blob=await fetch(im.data).then(r=>r.blob()),key=makeId('media_ds');await cacheFile(key,blob);refs.push({id:makeId('img'),filename:im.filename||key+'.png',mimeType:im.mimeType||blob.type||'image/png',cacheKey:key});ii++}if(opts.images||opts.prompts){const prompt=opts.prompts?src.prompt:'',ids=refs.map(x=>x.cacheKey);items.push({id:makeId('item_ds'),name:prompt.split(' ').slice(0,4).join(' ').trim()||'Imported Pose',prompt,image:ids[0]||'',images:ids,imageRefs:refs});if(opts.prompts&&src.prompt)ip++}}catch{ir++}setProgress([n+1,data.items.length])}const p={id:makeId('page_ds'),name,createdAt:new Date().toISOString(),items};setPages(x=>[...x,p]);setActive(p.id);setSummary([ip,ii,sd,ir]);setStep('complete')}
 const moveToVault=async(all:boolean)=>{if(!page||!onMoveToVault)return;const items=all?page.items:page.items.filter((item)=>vaultSel.has(item.id));if(!items.length)return;const message=all?`Move all ${items.length} imported card${items.length===1?'':'s'} from “${page.name}” to Prompt Vault?`:`Move ${items.length} selected card${items.length===1?'':'s'} from “${page.name}” to Prompt Vault?`;if(!window.confirm(message))return;onMoveToVault(items);const movedIds=new Set(items.map((item)=>item.id));setPages((current)=>current.map((p)=>({...p,items:p.items.filter((item)=>!movedIds.has(item.id))})).filter((p)=>p.items.length>0));setVaultSel(new Set());setActive((current)=>{const currentPage=pages.find((p)=>p.id===current);if(currentPage&&currentPage.items.some((item)=>movedIds.has(item.id)))return pages.find((p)=>p.id!==current&&p.items.length>0)?.id||null;return current});}
 const deleteAllImportedData=async()=>{if(!pages.length)return;if(!window.confirm('Delete all imported dataset data? This will permanently remove every imported page, prompt, and imported image. Your completed generations and source images will not be deleted.'))return;const keys=pages.flatMap(p=>p.items.flatMap(i=>i.imageRefs.map(r=>r.cacheKey)));await deleteCachedFiles(keys);setPages([]);setActive(null)};
 const deleteItem=async(item:PageItem)=>{if(!window.confirm(`Delete “${item.name}” from this dataset?`))return;await deleteCachedFiles(item.imageRefs.map(r=>r.cacheKey));setPages(current=>current.map(p=>p.id===active?{...p,items:p.items.filter(x=>x.id!==item.id)}:p).filter(p=>p.items.length>0));setVaultSel(current=>{const next=new Set(current);next.delete(item.id);return next})};
 const copyPrompt=async(item:PageItem)=>{if(!item.prompt)return;try{await navigator.clipboard?.writeText(item.prompt)}catch{}}; const exportPage=async(p:Page)=>{const out:Dataset={version:1,createdAt:new Date().toISOString(),items:[]};for(const i of p.items){const r:Item={prompt:i.prompt,images:[]};for(const im of i.imageRefs){const b=await getCachedFile(im.cacheKey);if(b)r.images.push({filename:im.filename,mimeType:im.mimeType||b.type||'image/png',data:await b64(b)})}out.items.push(r)}await download(p.name.replace(/[^a-z0-9]+/gi,'-')+'.json',JSON.stringify(out,null,2))}

 return <section className="dataset-page">
  <div className="dataset-page-header">
    <div><h2><span className="dataset-inline-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><ellipse cx="12" cy="5" rx="7" ry="3"/><path d="M5 5v7c0 1.7 3.1 3 7 3s7-1.3 7-3V5"/><path d="M5 12v7c0 1.7 3.1 3 7 3s7-1.3 7-3v-7"/></svg></span> Datasets</h2><span>Prompt Vault-compatible dataset JSON</span></div>
    <button className="close-btn" onClick={onClose}>×</button>
  </div>
  <div className="dataset-imported-layout">
    <div className="dataset-page-content">
      {pages.length > 1 && <div className="dataset-page-switcher">
        {pages.map(p=><button className={p.id===active?'active':''} key={p.id} onClick={()=>{setActive(p.id);setVaultSel(new Set())}}>
          <span>{p.name}</span><small>{p.items.length} records</small>
        </button>)}
      </div>}
      <div className="dataset-content-header dataset-empty-state">
        <div className="dataset-content-title">
          <h3>{page?.name||'Imported'}</h3>
          <span>{page?.items.length||0} records</span>
        </div>
        <div className="dataset-content-actions">
          <button className="dataset-action dataset-import" onClick={()=>setStep('upload')}>
            <span className="dataset-inline-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16V4"/><path d="m7 9 5-5 5 5"/><path d="M5 20h14"/></svg></span>
            Import JSON
          </button>
          <button className="dataset-action dataset-export" onClick={()=>page&&void exportPage(page)} disabled={!page}>
            <span className="dataset-inline-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></svg></span>
            Export JSON
          </button>
          <button className="dataset-action dataset-vault" onClick={()=>void moveToVault(false)} disabled={!page||!vaultSel.size}>
            Move Selected{vaultSel.size ? ` (${vaultSel.size})` : ''}
          </button>
          <button className="dataset-action dataset-vault" onClick={()=>void moveToVault(true)} disabled={!page||!page.items.length}>
            Move All to Prompt Vault
          </button>
          <button className="dataset-action dataset-danger" onClick={()=>void deleteAllImportedData()} disabled={!pages.length}>
            Delete All Imported Data
          </button>
        </div>
      </div>
      {page && <div className="dataset-record-grid">
        {page.items.map(i=> {
          const mime=(i.imageRefs[0]?.mimeType||'image/png').split('/')[1]?.toUpperCase()||'IMAGE';
          return <article className={`dataset-record${vaultSel.has(i.id)?' selected':''}`} key={i.id}>
            <div className="dataset-record-image-wrap">
              <button type="button" className="dataset-record-select" onClick={()=>setVaultSel(current=>{const next=new Set(current);next.has(i.id)?next.delete(i.id):next.add(i.id);return next})} aria-label={vaultSel.has(i.id)?`Deselect ${i.name}`:`Select ${i.name}`} aria-pressed={vaultSel.has(i.id)}>{vaultSel.has(i.id)?'✓':''}</button>
              <button type="button" className="dataset-record-more" onClick={()=>setViewer(i)} aria-label={`Open ${i.name}`}>•••</button>
              <button type="button" className="dataset-record-image-button" onClick={()=>setViewer(i)} aria-label={`Open ${i.name}`}><div className="dataset-record-image">{i.imageRefs[0]?<Cached keyId={i.imageRefs[0].cacheKey}/>:<span className="dataset-inline-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9" r="1.5"/><path d="m4 18 5-5 4 4 2-2 5 5"/></svg></span>}</div></button>
            </div>
            <div className="dataset-record-body">
              <strong>{i.name}</strong>
              <div className="dataset-record-prompt-preview">{i.prompt||'No prompt provided'}</div>
              <div className="dataset-record-meta"><span>▧ {i.imageRefs.length} {i.imageRefs.length===1?'image':'images'}</span><span>{mime}</span></div>
              <div className="dataset-record-actions">
                <button type="button" onClick={()=>void copyPrompt(i)} aria-label="Copy prompt" title="Copy prompt">▣</button>
                <button type="button" className={vaultSel.has(i.id)?'active':''} onClick={()=>setVaultSel(current=>{const next=new Set(current);next.has(i.id)?next.delete(i.id):next.add(i.id);return next})} aria-label="Select for Prompt Vault" title="Select">◇</button>
                <button type="button" onClick={()=>void moveToVault(false)} disabled={!vaultSel.has(i.id)} aria-label="Move to Prompt Vault" title="Move to Prompt Vault">□</button>
                <button type="button" className="dataset-record-delete" onClick={()=>void deleteItem(i)} aria-label="Delete record" title="Delete record">♜</button>
              </div>
            </div>
          </article>
        })}
      </div>}
        {viewer&&<div className="dataset-viewer-backdrop" onClick={()=>setViewer(null)}><section className="dataset-viewer" onClick={e=>e.stopPropagation()}><div className="dataset-viewer-header"><h3>{viewer.name}</h3><button className="close-btn" onClick={()=>setViewer(null)}>×</button></div><div className="dataset-viewer-image">{viewer.imageRefs[0]?<Cached keyId={viewer.imageRefs[0].cacheKey}/>:<div className="dataset-image-empty">No image</div>}</div><div className="dataset-viewer-prompt"><div><strong>Prompt</strong><button type="button" onClick={()=>void navigator.clipboard?.writeText(viewer.prompt)}>Copy</button></div><textarea className="dataset-viewer-prompt-editor" value={viewer.prompt} onChange={e=>{const next=e.target.value;setViewer(v=>v&&v.id===viewer.id?{...v,prompt:next}:v);setPages(ps=>ps.map(p=>p.id===active?{...p,items:p.items.map(x=>x.id===viewer.id?{...x,prompt:next}:x)}:p))}} onClick={e=>e.stopPropagation()} onPointerDown={e=>e.stopPropagation()} placeholder="No prompt provided" aria-label="Edit prompt"/></div></section></div>}
  {step!=='idle' && <div className="dataset-modal-backdrop"><section className="dataset-modal">
    <div className="dataset-modal-header"><h3><span className="dataset-inline-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h9l3 3v15H6z"/><path d="M15 3v4h4M9 11h6M9 15h6M9 19h4"/></svg></span> Import Dataset</h3><button className="close-btn" onClick={reset} disabled={step==='importing'}>×</button></div>
    {step==='upload' && <div className="dataset-modal-body dataset-upload-state"><span className="dataset-inline-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16V4"/><path d="m7 9 5-5 5 5"/><path d="M5 20h14"/></svg></span><h3>Upload Dataset JSON</h3><p>Import images and prompts into a new page.</p><button className="dataset-primary large" onClick={()=>input.current?.click()}><span className="dataset-inline-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16V4"/><path d="m7 9 5-5 5 5"/><path d="M5 20h14"/></svg></span> Select dataset.json</button><input ref={input} type="file" accept=".json,application/json" hidden onChange={upload}/>{err&&<div className="dataset-error">{err}</div>}</div>}
    {step==='preview' && data && <div className="dataset-modal-body"><div className="dataset-stats"><div><small>Records Found</small><strong>{data.items.length}</strong></div><div><small>Images Found</small><strong>{data.items.reduce((n,x)=>n+x.images.length,0)}</strong></div></div><div className="dataset-preview-list">{data.items.slice(0,50).map((x,i)=><div className="dataset-preview-row" key={i}>{x.images[0]?.data?<img src={x.images[0].data} alt=""/>:<span className="dataset-inline-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9" r="1.5"/><path d="m4 18 5-5 4 4 2-2 5 5"/></svg></span>}<p>{x.prompt||'No prompt provided'}</p></div>)}</div><div className="dataset-options"><label><input type="checkbox" checked={opts.images} onChange={e=>setOpts({...opts,images:e.target.checked})}/> Import Images</label><label><input type="checkbox" checked={opts.prompts} onChange={e=>setOpts({...opts,prompts:e.target.checked})}/> Import Prompts</label><div><span>Duplicate Handling</span><label><input type="radio" name="dataset-dupes" checked={opts.dupes==='skip'} onChange={()=>setOpts({...opts,dupes:'skip'})}/> Skip Duplicates</label><label><input type="radio" name="dataset-dupes" checked={opts.dupes==='all'} onChange={()=>setOpts({...opts,dupes:'all'})}/> Import All</label></div></div><div className="dataset-modal-actions"><button onClick={reset}>Cancel</button><button className="dataset-primary" onClick={()=>void doImport()}><span className="dataset-inline-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11"/><path d="m7 11 5 5 5-5"/><path d="M5 20h14"/></svg></span> Import Dataset</button></div></div>}
    {step==='importing' && <div className="dataset-modal-body dataset-progress"><span className="dataset-inline-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><ellipse cx="12" cy="5" rx="7" ry="3"/><path d="M5 5v7c0 1.7 3.1 3 7 3s7-1.3 7-3V5"/><path d="M5 12v7c0 1.7 3.1 3 7 3s7-1.3 7-3v-7"/></svg></span><h3>Importing Dataset...</h3><p>Processing record {progress[0]} / {progress[1]}</p><div className="dataset-progress-bar"><span style={{width:(progress[1]?(progress[0]/progress[1])*100:0)+'%'}}/></div></div>}
    {step==='complete' && <div className="dataset-modal-body dataset-complete"><span className="dataset-inline-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="m8 12 2.5 2.5L16 9"/></svg></span><h3>Import Complete</h3><div className="dataset-results"><span>Prompts <strong>{summary[0]}</strong></span><span>Images <strong>{summary[1]}</strong></span><span>Duplicates skipped <strong>{summary[2]}</strong></span><span>Invalid records <strong>{summary[3]}</strong></span></div><button className="dataset-primary large" onClick={reset}>Continue</button></div>}
  </section></div>}
 </section>
}
