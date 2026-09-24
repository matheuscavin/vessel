"""macOS native app/daemon lifetime check. Uses an isolated config directory."""
import json, os, pathlib, re, socket, struct, subprocess, tempfile, time
app = pathlib.Path('target/release/bundle/macos/Vessel.app/Contents/MacOS/vessel').resolve()
def exact(sock, n):
    chunks = bytearray()
    while len(chunks) < n:
        chunk = sock.recv(n-len(chunks))
        if not chunk: raise RuntimeError('Connection closed')
        chunks.extend(chunk)
    return bytes(chunks)
with tempfile.TemporaryDirectory(prefix='vessel-native-') as directory:
    endpoint = pathlib.Path(directory)/'endpoint.json'
    env = dict(os.environ, VESSEL_DATA_DIR=directory)
    ui = None
    def rpc(request):
        data = json.loads(endpoint.read_text())
        body = json.dumps({'token':data['token'],'request':request}).encode()
        with socket.create_connection(('127.0.0.1',data['port']),timeout=10) as sock:
            sock.sendall(struct.pack('>I',len(body))+body)
            status=exact(sock,1)[0]; size=struct.unpack('>I',exact(sock,4))[0]; result=exact(sock,size)
            if status: raise RuntimeError(result.decode())
            return result if request['op']=='read' else json.loads(result)
    try:
        ui=subprocess.Popen([str(app)],env=env)
        for _ in range(200):
            if endpoint.exists(): break
            assert ui.poll() is None, 'Native UI exited during startup'
            time.sleep(.05)
        w=rpc({'op':'createWorkspace','name':'Native smoke'})['state']['selectedWorkspace']
        s=rpc({'op':'createSession','workspaceId':w,'name':'Lifetime check','path':directory})['state']['selectedSession']
        snap=rpc({'op':'createTerminal','sessionId':s}); tid=snap['state']['selectedTerminal']; pid=snap['statuses'][tid]['pid']
        time.sleep(3)
        assert ui.poll() is None
        rpc({'op':'input','id':tid,'data':"printf 'UI_SIZE='; stty size\r"})
        time.sleep(.3)
        screen=rpc({'op':'read','id':tid,'cursor':None})[10:].decode(errors='replace')
        dimensions=re.search(r'UI_SIZE=(\d+) (\d+)',screen)
        assert dimensions, screen
        assert dimensions.groups()!=('30','100'), 'Native frontend did not resize the PTY through Tauri IPC'

        ui.terminate(); ui.wait(timeout=10)
        assert rpc({'op':'snapshot'})['statuses'][tid]['pid']==pid
        rpc({'op':'input','id':tid,'data':"printf 'NATIVE_%s\\n' SURVIVED\r"})
        time.sleep(.3)
        output=rpc({'op':'read','id':tid,'cursor':None})[10:]
        assert b'NATIVE_SURVIVED' in output
        ui=subprocess.Popen([str(app)],env=env); time.sleep(1)
        assert ui.poll() is None
        assert rpc({'op':'snapshot'})['statuses'][tid]['pid']==pid
        rpc({'op':'closeTerminal','id':tid})
        print('PASS: native app frontend resize through Tauri IPC, detached daemon survives UI termination, shell stays interactive, native reopen retains PID.')
    finally:
        if ui and ui.poll() is None: ui.terminate(); ui.wait(timeout=10)
        if endpoint.exists():
            try: os.kill(json.loads(endpoint.read_text())['pid'],15)
            except ProcessLookupError: pass
