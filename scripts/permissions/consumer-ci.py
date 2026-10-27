#!/usr/bin/env python3
"""Repository CI adapter; all manifest and online protocol logic belongs to the pinned SDK CLI."""
from __future__ import annotations
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import stat
import urllib.request
import urllib.error
import urllib.parse

MAX_JSON = 16 * 1024 * 1024


def read_json(path: Path):
    if path.is_symlink() or not path.is_file() or path.stat().st_size > MAX_JSON:
        raise ValueError('PERMISSION_CI_JSON_INVALID')
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError('PERMISSION_CI_DUPLICATE_KEY')
            result[key] = value
        return result
    return json.loads(path.read_text(), object_pairs_hook=pairs)


def required(name):
    value = os.environ.get(name, '')
    if not value or '\n' in value or '\r' in value:
        raise ValueError('PERMISSION_CI_REQUIRED_' + name)
    return value


def producer_config(root):
    config = read_json(root / 'permission-manifest.config.json')
    producer = config.get('producerId', '')
    if config.get('schemaVersion') != 1 or not re.fullmatch(r'[a-z][a-z0-9-]{0,127}', producer):
        raise ValueError('PERMISSION_CI_PRODUCER_INVALID')
    return [{'producerId': producer}]


def require_delivery_boundary():
    github = os.environ.get('GITHUB_ACTIONS') == 'true' and os.environ.get('GITHUB_REF_PROTECTED') == 'true' \
        and os.environ.get('GITHUB_EVENT_NAME') == 'workflow_dispatch'
    gitlab = os.environ.get('GITLAB_CI') == 'true' and os.environ.get('CI_COMMIT_REF_PROTECTED') == 'true' \
        and os.environ.get('CI_PIPELINE_SOURCE') in {'web', 'push', 'api', 'pipeline'}
    if os.environ.get('PERMISSION_DELIVERY_ENABLED') != 'true' or not (github or gitlab):
        raise ValueError('PERMISSION_CI_PROTECTED_MANUAL_DELIVERY_REQUIRED')
    if gitlab:
        now = datetime.datetime.now(datetime.timezone.utc)
        created = datetime.datetime.fromisoformat(required('CI_PIPELINE_CREATED_AT').replace('Z', '+00:00'))
        if created.tzinfo is None or not datetime.timedelta(0) <= now - created <= datetime.timedelta(hours=24):
            raise ValueError('PERMISSION_CI_PIPELINE_EXPIRED')
        branch = required('CI_COMMIT_BRANCH')
        commit = required('CI_COMMIT_SHA')
        if not re.fullmatch(r'[a-f0-9]{40}', commit):
            raise ValueError('PERMISSION_CI_COMMIT_INVALID')
        current = subprocess.run(['git', 'ls-remote', '--exit-code', 'origin', 'refs/heads/' + branch],
                                 capture_output=True, text=True, check=False)
        if current.returncode or current.stdout.split()[:1] != [commit]:
            raise ValueError('PERMISSION_CI_SUPERSEDED_PIPELINE')


def assert_readiness(proof, producer, evidence):
    if proof.get('schemaVersion') != 1 or proof.get('status') != 'READY' \
            or proof.get('producerId') != producer['producerId'] \
            or proof.get('artifactDigest') != evidence.get('artifactDigest') \
            or proof.get('commit') != evidence.get('artifact', {}).get('commit') \
            or proof.get('buildId') != evidence.get('artifact', {}).get('buildId'):
        raise ValueError('PERMISSION_CI_DEPLOYMENT_PROOF_MISMATCH')
    now = datetime.datetime.now(datetime.timezone.utc)
    verified = datetime.datetime.fromisoformat(proof.get('verifiedAt', '').replace('Z', '+00:00'))
    expires = datetime.datetime.fromisoformat(proof.get('expiresAt', '').replace('Z', '+00:00'))
    if verified.tzinfo is None or expires.tzinfo is None or not verified <= now < expires \
            or expires - verified > datetime.timedelta(minutes=10):
        raise ValueError('PERMISSION_CI_DEPLOYMENT_READINESS_EXPIRED')
    selection = proof.get('selection', {})
    entries = selection.get('producers', [])
    if not any(item.get('producerId') == producer['producerId'] and item.get('qualificationId') for item in entries):
        raise ValueError('PERMISSION_CI_EXISTING_QUALIFICATION_REQUIRED')
    return selection


def private_read_token():
    path = Path(required('PERMISSION_GITLAB_READ_TOKEN_FILE'))
    if not path.is_absolute() or path.is_symlink():
        raise ValueError('PERMISSION_CI_PRIVATE_READ_TOKEN_REQUIRED')
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode) or before.st_uid != os.getuid() or before.st_mode & 0o077 or before.st_size > 8192:
            raise ValueError('PERMISSION_CI_PRIVATE_READ_TOKEN_REQUIRED')
        data = os.read(descriptor, 8193)
        after = os.fstat(descriptor)
        if len(data) > 8192 or (before.st_ino, before.st_size, before.st_mtime_ns, before.st_mode) != (after.st_ino, after.st_size, after.st_mtime_ns, after.st_mode):
            raise ValueError('PERMISSION_CI_PRIVATE_READ_TOKEN_CHANGED')
    finally:
        os.close(descriptor)
    token = data.decode('utf-8').strip()
    if not token or any(ord(character) < 33 or ord(character) > 126 for character in token):
        raise ValueError('PERMISSION_CI_PRIVATE_READ_TOKEN_INVALID')
    return token


def strict_response(body):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError('PERMISSION_CI_DUPLICATE_RESPONSE_KEY')
            result[key] = value
        return result
    value = json.loads(body, object_pairs_hook=pairs)
    if not isinstance(value, dict):
        raise ValueError('PERMISSION_CI_GITLAB_RESPONSE_INVALID')
    return value


class NoCredentialRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, url):
        return None


def gitlab_read(url, token, artifact=False):
    opener = urllib.request.build_opener(NoCredentialRedirect())
    headers = {'Accept': 'application/json', 'PRIVATE-TOKEN': token}
    for hop in range(4):
        try:
            request = urllib.request.Request(url, headers=headers, method='GET')
            with opener.open(request, timeout=15) as response:
                if response.status != 200:
                    raise ValueError('PERMISSION_CI_GITLAB_READ_FAILED')
                body = response.read(MAX_JSON + 1)
                if len(body) > MAX_JSON:
                    raise ValueError('PERMISSION_CI_GITLAB_RESPONSE_TOO_LARGE')
                return strict_response(body)
        except urllib.error.HTTPError as failure:
            if artifact and failure.code in {301, 302, 303, 307, 308} and hop < 3:
                location = urllib.parse.urljoin(url, failure.headers.get('Location', ''))
                target = urllib.parse.urlsplit(location)
                if target.scheme != 'https' or not target.hostname or target.username or target.password or target.fragment:
                    raise ValueError('PERMISSION_CI_GITLAB_ARTIFACT_REDIRECT_INVALID') from None
                # GitLab artifact storage can use a signed CDN URL. Its query stays internal; no credential header follows it.
                url = location
                headers = {'Accept': 'application/json'}
                continue
            raise ValueError('PERMISSION_CI_GITLAB_READ_FAILED') from None
        except (urllib.error.URLError, TimeoutError):
            raise ValueError('PERMISSION_CI_GITLAB_READ_UNAVAILABLE') from None
    raise ValueError('PERMISSION_CI_GITLAB_ARTIFACT_REDIRECT_LIMIT')


def verify_gitlab_deployment(proof, evidence):
    if os.environ.get('GITLAB_CI') != 'true':
        return
    identity = proof.get('gitlab')
    if not isinstance(identity, dict) or set(identity) != {'projectId', 'pipelineId', 'jobId'} \
            or any(not isinstance(value, str) or not re.fullmatch(r'[1-9][0-9]{0,18}', value) for value in identity.values()) \
            or identity['projectId'] != required('CI_PROJECT_ID'):
        raise ValueError('PERMISSION_CI_GITLAB_PROVENANCE_REQUIRED')
    api = urllib.parse.urlsplit(required('CI_API_V4_URL'))
    server = urllib.parse.urlsplit(required('CI_SERVER_URL'))
    if api.scheme != 'https' or server.scheme != 'https' or not server.hostname \
            or (api.hostname, api.port) != (server.hostname, server.port) \
            or api.path.rstrip('/') != server.path.rstrip('/') + '/api/v4' \
            or any([api.username, api.password, api.query, api.fragment, server.username, server.password, server.query, server.fragment]):
        raise ValueError('PERMISSION_CI_GITLAB_API_ORIGIN_INVALID')
    expected_job = required('PERMISSION_DEPLOYMENT_JOB_NAME')
    if expected_job in {'build-and-unit-tests', 'validate', 'permission-offline-validation', 'permission-register', 'permission-activate', os.environ.get('CI_JOB_NAME')}:
        raise ValueError('PERMISSION_CI_SEPARATE_DEPLOYMENT_JOB_REQUIRED')
    base = required('CI_API_V4_URL').rstrip('/') + '/projects/' + identity['projectId']
    token = private_read_token()
    job = gitlab_read(base + '/jobs/' + identity['jobId'], token)
    commit = evidence.get('artifact', {}).get('commit')
    branch = required('CI_COMMIT_BRANCH')
    if str(job.get('id')) != identity['jobId'] or job.get('name') != expected_job or job.get('status') != 'success' \
            or job.get('ref') != branch or job.get('tag') is not False or job.get('erased_at') is not None \
            or job.get('commit', {}).get('id') != commit or str(job.get('pipeline', {}).get('id')) != identity['pipelineId']:
        raise ValueError('PERMISSION_CI_GITLAB_DEPLOYMENT_JOB_MISMATCH')
    finished = datetime.datetime.fromisoformat(job.get('finished_at', '').replace('Z', '+00:00'))
    verified = datetime.datetime.fromisoformat(proof.get('verifiedAt', '').replace('Z', '+00:00'))
    now = datetime.datetime.now(datetime.timezone.utc)
    if finished.tzinfo is None or not verified - datetime.timedelta(seconds=60) <= finished <= now:
        raise ValueError('PERMISSION_CI_GITLAB_DEPLOYMENT_TIME_INVALID')
    pipeline = gitlab_read(base + '/pipelines/' + identity['pipelineId'], token)
    if str(pipeline.get('id')) != identity['pipelineId'] or pipeline.get('status') != 'success' or pipeline.get('sha') != commit \
            or pipeline.get('ref') != branch or pipeline.get('source') not in {'web', 'push', 'api', 'pipeline', 'parent_pipeline'}:
        raise ValueError('PERMISSION_CI_GITLAB_DEPLOYMENT_PIPELINE_MISMATCH')
    archived = gitlab_read(base + '/jobs/' + identity['jobId'] + '/artifacts/permission-deployment.json', token, artifact=True)
    if archived != proof:
        raise ValueError('PERMISSION_CI_GITLAB_DEPLOYMENT_ARTIFACT_MISMATCH')



def run(phase, root):
    lock_path = root / 'permission-toolchain.lock.json'
    lock = read_json(lock_path)
    if phase in {'register', 'activate'} and lock.get('mode') != 'PINNED_COMMIT':
        raise ValueError('PERMISSION_CI_LOCAL_TOOLCHAIN_ONLINE_FORBIDDEN')
    if phase == 'pin':
        commit = lock.get('sdk', {}).get('commit', '')
        if lock.get('mode') != 'PINNED_COMMIT' or not isinstance(commit, str) or not re.fullmatch(r'(?:[a-f0-9]{40}|[a-f0-9]{64})', commit):
            raise ValueError('PERMISSION_CI_REQUIRES_REAL_COMMITTED_TOOLCHAIN_PIN')
        print(commit)
        return 0
    sdk = Path(required('PERMISSION_SDK_ROOT')).resolve()
    if phase == 'prepare':
        artifact = Path(required('PERMISSION_CONTRACT_ARTIFACT_FILE')).resolve()
        if artifact.is_symlink() or not artifact.is_file() or artifact.stat().st_size > 64 * 1024 * 1024 \
                or hashlib.sha256(artifact.read_bytes()).hexdigest() != lock.get('contract', {}).get('sha256'):
            raise ValueError('PERMISSION_CI_CONTRACT_ARTIFACT_MISMATCH')
        return subprocess.run(['node', str(sdk / 'scripts/permission-manifest.mjs'), 'prepare', '--lock', str(lock_path),
                               '--artifact', str(artifact)], cwd=root, check=False).returncode
    if phase not in {'validate', 'register', 'activate'}:
        raise ValueError('PERMISSION_CI_PHASE_INVALID')
    producers = producer_config(root)
    build = Path(required('PERMISSION_BUILD_ROOT')).resolve()
    output = Path(required('PERMISSION_OUTPUT_ROOT')).resolve()
    if phase != 'validate':
        require_delivery_boundary()
        selected = required('PERMISSION_PRODUCER_ID')
        producers = [value for value in producers if value['producerId'] == selected]
        if len(producers) != 1:
            raise ValueError('PERMISSION_CI_UNKNOWN_PRODUCER')
    for producer in producers:
        module = build / '.generated/permissions'
        evidence_path = module / 'artifact-record.json'
        evidence = read_json(evidence_path)
        if evidence.get('producerId') != producer['producerId'] or evidence.get('status') != 'BUILT':
            raise ValueError('PERMISSION_CI_ARTIFACT_PRODUCER_MISMATCH')
        result = output / producer['producerId']
        args = ['node', str(sdk / 'scripts/permissions/ci.mjs'), '--phase', phase, '--lock', str(lock_path), '--output-dir', str(result)]
        artifact_flags = ['--manifest', str(module / 'manifest-v1.json'), '--evidence', str(evidence_path),
                          '--artifact', str(build / 'dist')]
        if phase in {'validate', 'register'}:
            args += artifact_flags
        if phase != 'validate':
            args += ['--target', required('PERMISSION_TARGET'), '--target-file', str(root / 'permission-targets.json')]
        if phase == 'register':
            for flag, variable in [('expected-producer-revision', 'PERMISSION_EXPECTED_PRODUCER_REVISION'),
                                   ('expected-active-revision', 'PERMISSION_EXPECTED_ACTIVE_REVISION'),
                                   ('operation-id', 'PERMISSION_OPERATION_ID')]:
                args += ['--' + flag, required(variable)]
            args += ['--wait-seconds', '120']
        if phase == 'activate':
            # Reuse the exact packaged build; activation never rebuilds, qualifies, or deploys it.
            validation = ['node', str(sdk / 'scripts/permissions/ci.mjs'), '--phase', 'validate', '--lock', str(lock_path),
                          '--output-dir', str(result)] + artifact_flags
            checked = subprocess.run(validation, cwd=root, check=False).returncode
            if checked:
                return checked
            proof = read_json(Path(required('PERMISSION_DEPLOYMENT_EVIDENCE_FILE')))
            selection = assert_readiness(proof, producer, evidence)
            verify_gitlab_deployment(proof, evidence)
            result.mkdir(parents=True, exist_ok=True)
            selection_path = result / 'activation-selection.json'
            selection_path.write_text(json.dumps(selection, separators=(',', ':')) + '\n')
            args += ['--selection', str(selection_path)]
        status = subprocess.run(args, cwd=root, check=False).returncode
        if status:
            return status  # Keep pending=6 and the original operationId; never retry a write here.
    return 0


if __name__ == '__main__':
    try:
        if len(sys.argv) != 2:
            raise ValueError('PERMISSION_CI_PHASE_REQUIRED')
        sys.exit(run(sys.argv[1], Path(__file__).resolve().parents[1]))
    except (ValueError, OSError, KeyError, TypeError):
        # Configuration and HTTP errors must not echo credentials, file payloads, or response bodies.
        print('Permission CI input or trust boundary failed; check pinned toolchain, explicit producer and deployment evidence', file=sys.stderr)
        sys.exit(2)
