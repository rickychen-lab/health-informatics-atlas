import { SyncDocument, blankState, flattenState, expandState, sanitizeLegacyState, MAX_NOTE_LENGTH } from './sync-core.js';
const clone=x=>JSON.parse(JSON.stringify(x));
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const readJSON=(key,fallback)=>{try{return JSON.parse(localStorage.getItem(key)||'null')||fallback}catch{return fallback}};
export class AccountSync {
  constructor(hooks){this.hooks=hooks;this.user=null;this.doc=new SyncDocument();this.status='checking';this.lastSync=null;this.busy=false;this.epoch=0;this.seq=0;this.ready=false;this.error='';this.legacy=null;this.channel=null;this.tabId=crypto.randomUUID();this.editor=null;this.sessionChanged=false;
    try{this.channel=new BroadcastChannel('atlas-account-session');this.channel.onmessage=event=>{if(event.data?.type==='identity-changed')this.invalidateSession()}}catch{}
    window.addEventListener('online',()=>this.refresh());window.addEventListener('focus',()=>this.refresh());document.addEventListener('visibilitychange',()=>{if(!document.hidden)this.refresh()});
    setInterval(()=>{if(this.ready&&!document.hidden)this.refresh()},20000);
  }
  get pendingCount(){return Object.keys(this.doc.pending).length}
  get conflictCount(){return Object.keys(this.doc.conflicts).length}
  cacheKey(){return 'health-atlas-account-v2:'+encodeURIComponent(this.user.id)+':'+this.tabId}
  persist(){if(!this.user)return false;try{localStorage.setItem(this.cacheKey(),JSON.stringify(this.doc.toJSON()));return true}catch{this.error='Browser backup is unavailable. Keep this tab open until cloud sync succeeds.';this.status='error';return false}}
  notify(){this.hooks.onStatus?.()}
  invalidateSession(){this.persist();this.epoch++;this.seq++;this.sessionChanged=true;this.ready=false;this.user=null;this.doc=new SyncDocument();this.editor=null;this.legacy=null;this.lastSync=null;clearTimeout(this.timer);this.status='session-changed';this.error='Your account session changed in another tab. Reload this page to verify your account before saving more work.';this.hooks.onState(blankState(),'identity');this.notify()}
  setState(reason){this.hooks.onState(expandState(this.doc.valueSnapshot()),reason)}
  guestState(){try{return sanitizeLegacyState(readJSON('health-atlas-v1',blankState()))}catch{return blankState()}}
  async request(path,options={}){const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),12000);try{return await fetch(path,{credentials:'same-origin',cache:'no-store',...options,signal:controller.signal})}finally{clearTimeout(timer)}}
  async init(){try{await this.refreshIdentity();if(this.user)await this.pull();else this.hooks.onState(this.guestState(),'identity')}catch{this.status='offline';if(this.user){this.error='Cloud progress could not be loaded. Account changes stay queued on this device until you reconnect.';this.setState('identity')}else{this.error='Connect to verify your account. Cloud notes are not opened until identity is confirmed.';this.hooks.onState(this.guestState(),'identity')}}this.ready=true;this.notify();if(this.user&&this.pendingCount)this.schedule()}
  async refreshIdentity(){if(this.sessionChanged)return null;const epoch=this.epoch,seq=++this.seq;const res=await this.request('/api/account');if(epoch!==this.epoch||seq!==this.seq)return this.user;if(!res.ok)throw new Error('Account check failed');const data=await res.json();if(epoch!==this.epoch||seq!==this.seq)return this.user;const next=data.user||null;
    if((next?.id||null)!==(this.user?.id||null)){
      this.persist();this.epoch++;this.editor=null;this.user=next;this.lastSync=null;this.error='';this.doc=new SyncDocument();
      if(next){this.doc=new SyncDocument(readJSON(this.cacheKey(),{}));this.status='syncing';this.legacy=this.guestState();this.setState('identity')}
      else {this.status='guest';this.legacy=null;this.hooks.onState(this.guestState(),'identity')}
    }else if(!next)this.status='guest';
    this.signInUrl=data.signInUrl||'/signin-with-chatgpt?return_to=%2F%23progress';this.signOutUrl=data.signOutUrl||'/signout-with-chatgpt?return_to=%2F%23progress';this.notify();return next;
  }
  async pull(){if(!this.user)return;const epoch=this.epoch,id=this.user.id;const res=await this.request('/api/progress');if(epoch!==this.epoch)return;if(res.status===401){await this.refreshIdentity();return}if(!res.ok)throw new Error('Could not load cloud progress');const data=await res.json();if(epoch!==this.epoch)return;if(data.userId!==id){await this.refreshIdentity();return}
    this.doc.ingest(data.items);this.persist();this.lastSync=new Date();this.status=this.conflictCount?'conflict':this.pendingCount?'pending':'synced';this.error='';this.setState('remote');this.notify();
  }
  schedule(){clearTimeout(this.timer);this.timer=setTimeout(()=>this.refresh(),900)}
  save(state){if(this.sessionChanged){this.hooks.toast('Your account session changed. Reload before saving more work.');return}if(!this.ready)return; if(!this.user){try{localStorage.setItem('health-atlas-v1',JSON.stringify(state))}catch{this.hooks.toast('Your browser could not save progress. Export a backup.')}this.notify();return}
    this.doc.stage(flattenState(state));
    if(this.editor){const {key,baseVersion}=this.editor;const pending=this.doc.pending[key],remote=this.doc.records[key];if(pending&&remote&&remote.version>baseVersion){pending.baseVersion=baseVersion;this.doc.ingest({[key]:remote})}}
    this.persist();this.status=this.conflictCount?'conflict':'pending';this.notify();this.schedule();
  }
  async refresh(){if(this.busy||!this.ready)return;this.busy=true;this.status=this.user?'syncing':this.status;this.notify();try{
      await this.refreshIdentity();if(!this.user)return;
      // Send the original per-field base versions before reading a newer snapshot.
      for(let round=0;round<20;round++){
        const batch=this.doc.batch(100);if(!batch.length)break;
        const id=this.user.id,epoch=this.epoch;
        const operations=batch.map(({key,value,baseVersion})=>({key,value,baseVersion}));
        const res=await this.request('/api/progress',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({expectedUserId:id,operations})});
        if(epoch!==this.epoch)return;
        if(res.status===401){await this.refreshIdentity();return}
        const data=await res.json();
        if(res.status===409&&data.code==='ACCOUNT_CHANGED'){await this.refreshIdentity();return}
        if(!res.ok)throw new Error(data.error||data.message||'Cloud save failed');
        if(data.userId!==id){await this.refreshIdentity();return}
        this.doc.acceptResponse(batch,data);if(this.editor&&data.applied[this.editor.key])this.editor.baseVersion=data.applied[this.editor.key].version;this.persist();this.setState('ack');
      }
      await this.pull();
    }catch(err){this.status='offline';this.error=err.name==='AbortError'?'Connection timed out. Your changes remain queued on this device.':String(err.message||err);this.persist();this.notify()}
    finally{this.busy=false;this.notify();if(this.pendingCount&&!this.conflictCount&&this.status!=='offline')this.schedule()}
  }
  hasLegacy(){const s=this.guestState();return s.read.length||Object.keys(s.answers).length||Object.keys(s.notes).length||Object.keys(s.checks).length||Object.keys(s.labChecks).length}
  recoverableDrafts(){if(!this.user)return [];const prefix='health-atlas-account-v2:'+encodeURIComponent(this.user.id)+':',drafts=[];try{for(let index=0;index<localStorage.length;index++){const key=localStorage.key(index);if(!key?.startsWith(prefix)||key===this.cacheKey())continue;try{const saved=new SyncDocument(readJSON(key,{})),count=Object.keys(saved.pending).length;if(count)drafts.push({cacheKey:key,count})}catch{}}}catch{}return drafts}
  async recoverDraft(cacheKey){if(!this.user)throw new Error('Sign in to recover account drafts.');const accountId=this.user.id,prefix='health-atlas-account-v2:'+encodeURIComponent(accountId)+':';if(typeof cacheKey!=='string'||!cacheKey.startsWith(prefix)||cacheKey===this.cacheKey())throw new Error('This draft does not belong to the current account.');await this.refresh();if(this.user?.id!==accountId)throw new Error('Your account changed. Check the signed-in account before recovering a draft.');if(this.busy||this.status==='offline')throw new Error('Reconnect and finish syncing before recovering a draft.');
    const saved=readJSON(cacheKey,null);if(!saved)throw new Error('This draft is no longer available.');const draft=new SyncDocument(saved),candidate=new SyncDocument(this.doc.toJSON()),remote={};
    for(const [key,pending]of Object.entries(draft.pending)){if(candidate.pending[key]&&!same(candidate.pending[key].value,pending.value))throw new Error('Resolve or finish syncing your current changes before recovering this draft. The original draft is still safe.');if(!candidate.pending[key])candidate.pending[key]=clone(pending);remote[key]=candidate.records[key]||{value:null,version:0,updatedAt:null}}
    candidate.ingest(remote);const previous=this.doc;this.doc=candidate;if(!this.persist()){this.doc=previous;throw new Error('The recovered draft could not be backed up. The original draft is still safe.')}
    // Keep an untouched archive before retiring the old outbox, including conflict copies.
    localStorage.setItem('health-atlas-recovered-draft-backup:'+encodeURIComponent(accountId)+':'+crypto.randomUUID(),JSON.stringify(saved));
    localStorage.setItem(cacheKey,JSON.stringify({records:draft.records,pending:{},conflicts:{}}));this.setState('recover');this.status=this.conflictCount?'conflict':this.pendingCount?'pending':'synced';this.notify();this.schedule();
  }
  async importState(input,moveGuest=false){if(this.sessionChanged)throw new Error('Reload to verify your changed account session before importing.');const incoming=sanitizeLegacyState(input);if(this.user){const accountId=this.user.id;await this.refresh();if(this.user?.id!==accountId)throw new Error('Your account changed. Check the signed-in account before importing.');if(this.busy)throw new Error('Sync is still running. Try again in a moment.');const now=expandState(this.doc.valueSnapshot());
      now.read=[...new Set([...now.read,...incoming.read])];
      for(const field of ['checks','labChecks'])for(const [key,value]of Object.entries(incoming[field]))now[field][key]=!!(now[field][key]||value);
      for(const [key,value]of Object.entries(incoming.answers)){if(!now.answers[key]||Date.parse(value.at)>Date.parse(now.answers[key].at))now.answers[key]=value}
      for(const [key,value]of Object.entries(incoming.notes)){if(!value)continue;if(!now.notes[key])now.notes[key]=value;else if(now.notes[key]!==value)now.notes[key]+='\n\n— Imported note —\n'+value;if(now.notes[key].length>MAX_NOTE_LENGTH)throw new Error('A merged note exceeds 32,768 characters. Shorten it before importing.')}
      this.hooks.onState(now,'import');this.save(now);
      if(moveGuest){if(!this.persist())throw new Error('Local account backup failed. The original browser records have been kept.');localStorage.setItem('health-atlas-legacy-backup:'+encodeURIComponent(this.user.id),JSON.stringify(incoming));localStorage.removeItem('health-atlas-v1')}
      this.legacy=null;
    }else{localStorage.setItem('health-atlas-v1',JSON.stringify(incoming));this.hooks.onState(incoming,'import')}this.notify();
  }
  resolve(key,choice){this.doc.resolve(key,choice);this.persist();this.setState('resolve');this.status=this.conflictCount?'conflict':'pending';this.notify();this.schedule()}
  async reset(){if(this.sessionChanged)throw new Error('Reload to verify your changed account session before resetting.');if(this.user){const accountId=this.user.id;await this.refresh();if(this.user?.id!==accountId)throw new Error('Your account changed. Check the signed-in account before resetting.');if(this.status==='offline'||this.busy)throw new Error('Reconnect and finish syncing before resetting cloud progress.');const next=blankState();next.zh=expandState(this.doc.valueSnapshot()).zh;this.doc.stage(flattenState(next));this.persist();this.setState('reset');this.status=this.conflictCount?'conflict':'pending';this.notify();this.schedule()}else{const next=blankState();localStorage.setItem('health-atlas-v1',JSON.stringify(next));this.hooks.onState(next,'reset')}}
  beforeSignOut(){if(this.pendingCount){if(!this.persist()){this.hooks.toast('Sign-out paused: your unsynced changes could not be backed up. Keep this tab open, reconnect and sync, or export a backup before trying again.');this.notify();return false}if(!confirm('Some changes are not synced yet. They will remain on this device for this account. Sign out anyway?'))return false}else this.persist();this.epoch++;this.ready=false;this.editor=null;this.channel?.postMessage({type:'identity-changed'});this.user=null;this.doc=new SyncDocument();this.hooks.onState(blankState(),'identity');this.status='guest';this.notify();return true}
  label(){if(this.sessionChanged)return 'Session changed · reload';if(!this.user)return this.status==='checking'?'Checking account…':this.status==='offline'?'Connection unavailable':'Sign in to sync';return ({syncing:'Syncing…',pending:'Changes waiting to sync',synced:'Saved to your account',conflict:'Review conflicting changes',offline:'Offline · saved on this device',error:'Backup unavailable'})[this.status]||'Connected'}
}
