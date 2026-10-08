# SPDX-License-Identifier: LicenseRef-Yantu-Source-Available
"""Reconstruct and validate a notice-only release ZIP from trusted SHA-256 inputs."""
import argparse
import base64
import gzip
import hashlib
import json
from pathlib import Path
import zipfile

parser=argparse.ArgumentParser()
parser.add_argument('--base',type=Path,required=True)
parser.add_argument('--recipe',type=Path,required=True)
parser.add_argument('--output',type=Path,required=True)
parser.add_argument('--before-sha256',required=True)
parser.add_argument('--after-sha256',required=True)
args=parser.parse_args()
with args.base.open('rb') as stream:
    if hashlib.file_digest(stream,'sha256').hexdigest()!=args.before_sha256:
        raise SystemExit('Original release digest mismatch')
with gzip.open(args.recipe,'rt',encoding='utf-8') as stream:
    recipe=json.load(stream)
if recipe['version']!=1 or recipe['baseSha256']!=args.before_sha256 or recipe['targetSha256']!=args.after_sha256:
    raise SystemExit('Untrusted delta metadata')
if recipe['baseBytes']!=args.base.stat().st_size or recipe['targetBytes']>=2*1024**3:
    raise SystemExit('Unexpected release size')
written=0
with args.base.open('rb') as original,args.output.open('xb') as output:
    for part in recipe['parts']:
        if part[0]=='copy':
            offset,length=part[1:]
            if offset<0 or length<0 or offset+length>recipe['baseBytes']:
                raise SystemExit('Invalid source byte range')
            original.seek(offset)
            while length:
                block=original.read(min(length,1024*1024))
                if not block:
                    raise SystemExit('Truncated source byte range')
                output.write(block)
                written+=len(block)
                length-=len(block)
        elif part[0]=='data':
            block=base64.b64decode(part[1],validate=True)
            output.write(block)
            written+=len(block)
        else:
            raise SystemExit('Unknown delta operation')
        if written>recipe['targetBytes']:
            raise SystemExit('Delta exceeds declared size')
if written!=recipe['targetBytes']:
    raise SystemExit('Reconstructed release size mismatch')
with args.output.open('rb') as stream:
    if hashlib.file_digest(stream,'sha256').hexdigest()!=args.after_sha256:
        raise SystemExit('Reconstructed release digest mismatch')
allowed={'README.md','NOTICE','AGENTS.md','CLAUDE.md','AI_USAGE_POLICY.md',
         '.github/copilot-instructions.md','plugins/yingce/README.md','plugins/yingce/AGENTS.md'}
prefix='Yantu-v1.6.0-axon.2/'
with zipfile.ZipFile(args.base) as old_zip,zipfile.ZipFile(args.output) as new_zip:
    old=json.loads(old_zip.read(prefix+'portable-manifest.json'))
    manifest=json.loads(new_zip.read(prefix+'portable-manifest.json'))
    prior={v['path']:v for v in old['files']}
    current={v['path']:v for v in manifest['files']}
    if manifest['sourceCommit']!=old['sourceCommit'] or set(prior)-set(current):
        raise SystemExit('Runtime provenance or file set was removed')
    if set(current)-set(prior)-allowed:
        raise SystemExit('Unexpected added file')
    if any(prior[name]!=current[name] for name in prior if name not in allowed):
        raise SystemExit('A runtime file changed')
    names=new_zip.namelist()
    if len(names)!=len(set(names)) or set(names)!={prefix+name for name in current}|{prefix+'portable-manifest.json'}:
        raise SystemExit('Archive contains unexpected entries')
    for name,record in current.items():
        with new_zip.open(prefix+name) as stream:
            actual=hashlib.file_digest(stream,'sha256').hexdigest()
        if actual!=record['sha256'] or new_zip.getinfo(prefix+name).file_size!=record['bytes']:
            raise SystemExit('Archive entry does not match manifest: '+name)
print(json.dumps({'sha256':args.after_sha256,'bytes':written,'files':len(names),
                  'runtimeFilesUnchanged':True,'policyCommit':manifest['policyCommit']}))
