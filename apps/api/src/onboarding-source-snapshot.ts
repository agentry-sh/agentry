/**
 * Standalone Node 20+ helper for a bounded fingerprint of committed Git source.
 * It is served verbatim and intentionally has no API-package dependency.
 */
export const ONBOARDING_SOURCE_SNAPSHOT_FILENAME = "agentry-source-snapshot.mjs" as const;
export const ONBOARDING_SOURCE_SNAPSHOT_PATH = "/v1/onboarding/source-snapshot.mjs" as const;

export const ONBOARDING_SOURCE_SNAPSHOT_NODE = String.raw`#!/usr/bin/env node
import{createHash}from"node:crypto";
import{execFileSync}from"node:child_process";
const ALGORITHM="agentry-source-tree-sha256-v1";
const MAX_FILES=50000,MAX_BYTES=536870912,MAX_TREE_BYTES=67108864,MAX_PATH_BYTES=4096;
class SnapshotFailure extends Error{}
const fail=code=>{throw new SnapshotFailure(code)};

function git(args,options={}){
  try{return execFileSync("git",args,{encoding:null,stdio:[options.input?"pipe":"ignore","pipe","pipe"],maxBuffer:options.maxBuffer??MAX_TREE_BYTES,input:options.input});}
  catch{fail(options.code??"git_command_failed")}
}

function records(bytes){
  const result=[];
  let start=0;
  for(let index=0;index<bytes.length;index+=1){
    if(bytes[index]!==0)continue;
    result.push(bytes.subarray(start,index));
    start=index+1;
  }
  if(start!==bytes.length)fail("invalid_git_tree");
  return result;
}

function head(root){
  const value=git(["-C",root,"rev-parse","--verify","HEAD^{commit}"],{code:"git_head_unavailable"}).toString("ascii").trim().toLowerCase();
  if(!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value))fail("git_head_unavailable");
  return value;
}

function assertClean(root){
  const status=git(["-C",root,"status","--porcelain=v1","-z","--untracked-files=no","--ignore-submodules=none"],{code:"git_status_unavailable"});
  if(status.length)fail("tracked_source_not_clean");
}

function tree(root,gitHead){
  const listing=git(["-C",root,"ls-tree","-r","-l","-z","--full-tree",gitHead],{code:"git_tree_unavailable"});
  const entries=[];
  let total=0;
  for(const record of records(listing)){
    if(entries.length>=MAX_FILES)fail("source_file_limit");
    const tab=record.indexOf(9);
    if(tab<1)fail("invalid_git_tree");
    const metadata=record.subarray(0,tab).toString("ascii");
    const match=/^(100644|100755|120000|160000) (blob|commit) ([0-9a-f]+) +(-|[0-9]+)$/.exec(metadata);
    const path=record.subarray(tab+1);
    if(!match||!path.length||path.length>MAX_PATH_BYTES)fail("invalid_git_tree");
    const mode=match[1],type=match[2],oid=match[3],sizeText=match[4];
    if(oid.length!==gitHead.length||(mode==="160000")!==(type==="commit")||(type==="blob")!==(sizeText!=="-"))fail("invalid_git_tree");
    const size=type==="commit"?oid.length:Number(sizeText);
    if(!Number.isSafeInteger(size)||size<0||total+size>MAX_BYTES)fail("source_byte_limit");
    total+=size;
    entries.push({mode,oid,path,size,type});
  }
  entries.sort((left,right)=>Buffer.compare(left.path,right.path));
  for(let index=1;index<entries.length;index+=1){
    if(Buffer.compare(entries[index-1].path,entries[index].path)===0)fail("duplicate_git_path");
  }
  return{entries,total};
}

function blobs(root,entries,total){
  const wanted=entries.filter(entry=>entry.type==="blob");
  if(!wanted.length)return[];
  const input=Buffer.from(wanted.map(entry=>entry.oid).join("\n")+"\n","ascii");
  const output=git(["-C",root,"cat-file","--batch"],{
    code:"git_blob_unavailable",input,maxBuffer:total+wanted.length*128+1024,
  });
  const result=[];
  let offset=0;
  for(const entry of wanted){
    const newline=output.indexOf(10,offset);
    if(newline<0)fail("invalid_git_blob");
    const header=output.subarray(offset,newline).toString("ascii");
    const match=/^([0-9a-f]+) blob ([0-9]+)$/.exec(header);
    if(!match||match[1]!==entry.oid||Number(match[2])!==entry.size)fail("invalid_git_blob");
    const start=newline+1,end=start+entry.size;
    if(end>=output.length||output[end]!==10)fail("invalid_git_blob");
    result.push(output.subarray(start,end));
    offset=end+1;
  }
  if(offset!==output.length)fail("invalid_git_blob");
  return result;
}

function fingerprint(entries,blobBytes){
  const hash=createHash("sha256");
  hash.update(ALGORITHM+"\0","ascii");
  let blobIndex=0;
  for(const entry of entries){
    const content=entry.type==="blob"?blobBytes[blobIndex++]:Buffer.from(entry.oid,"ascii");
    hash.update(entry.mode+"\0"+entry.path.length+"\0","ascii");
    hash.update(entry.path);
    hash.update("\0"+content.length+"\0","ascii");
    hash.update(content);
    hash.update("\0","ascii");
  }
  return hash.digest("hex");
}

function main(){
  const args=process.argv.slice(2);
  if(args.length>1||(args.length===1&&args[0]!=="--final"))fail("usage: agentry-source-snapshot.mjs [--final]");
  const final=args[0]==="--final";
  const inside=git(["rev-parse","--is-inside-work-tree"],{code:"not_a_git_repository"}).toString("ascii").trim();
  if(inside!=="true")fail("not_a_git_repository");
  const root=process.cwd();
  if(final)assertClean(root);
  const gitHead=head(root);
  const snapshot=tree(root,gitHead);
  const blobBytes=blobs(root,snapshot.entries,snapshot.total);
  const sourceFingerprint=fingerprint(snapshot.entries,blobBytes);
  if(final){
    assertClean(root);
    if(head(root)!==gitHead)fail("source_changed_during_snapshot");
  }
  process.stdout.write(JSON.stringify({
    git_head_sha:gitHead,
    source_fingerprint_sha256:sourceFingerprint,
    source_fingerprint_algorithm:ALGORITHM,
  })+"\n");
}

try{main()}catch(error){
  const code=error instanceof SnapshotFailure?error.message:"source_snapshot_failed";
  process.stderr.write(code+"\n");
  process.exitCode=1;
}
`;
