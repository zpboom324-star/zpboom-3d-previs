"""打安装包（Mac / Windows 通用）。
用法：python tools/make_package.py 2.7.4 [输出目录]
从仓库里的 zpboom-3d-previs/ 生成：
  <输出目录>/ZPboom.AI_3D预演导演_v<版本>.zip
    └ ZPboom.AI_3D预演导演_v<版本>/
        zpboom-3d-previs/      技能文件夹
        安装包/<同名>.zip       只含技能文件夹的安装 zip
        README.md              教程（链接改成指向 zpboom-3d-previs/ 里）
        可复制指令.txt          来自 tools/pkg_base/，{VER} 换成版本号
        示例预览.png            来自 zpboom-3d-previs/docs/preview.png
        交付清单.json           名称、版本、日期、本版改动（取 CHANGELOG 最上面一节）、每个文件的大小和 sha256
发布前先确认 SKILL.md 的 version、CHANGELOG 最上面一节、app.js / index.html 里的 ?v= 版本号都已经改成新版本。"""
import datetime, hashlib, json, re, shutil, sys, zipfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SKILL, BASE = REPO / 'zpboom-3d-previs', REPO / 'tools' / 'pkg_base'
VER = sys.argv[1] if len(sys.argv) > 1 else sys.exit('用法：python tools/make_package.py <版本号> [输出目录]')
OUT = Path(sys.argv[2]) if len(sys.argv) > 2 else REPO / 'dist'
NAME = f'ZPboom.AI_3D预演导演_v{VER}'
skill_ver = re.search(r'version:\s*"([^"]+)"', (SKILL / 'SKILL.md').read_text(encoding='utf-8')).group(1)
if skill_ver != VER: sys.exit(f'SKILL.md 里的版本是 {skill_ver}，和要打的 {VER} 不一致，先改 SKILL.md')

stage = OUT / NAME
if stage.exists(): shutil.rmtree(stage)
stage.mkdir(parents=True)
shutil.copytree(SKILL, stage / 'zpboom-3d-previs', ignore=shutil.ignore_patterns('.DS_Store', '__pycache__', '*.pyc'))
def zipdir(zpath, base, rel):
    with zipfile.ZipFile(zpath, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for p in sorted((base / rel).rglob('*')): z.write(p, p.relative_to(base).as_posix())
(stage / '安装包').mkdir()
zipdir(stage / '安装包' / f'{NAME}.zip', stage, 'zpboom-3d-previs')
shutil.copy(SKILL / 'docs' / 'preview.png', stage / '示例预览.png')
(stage / '可复制指令.txt').write_text((BASE / '可复制指令.txt').read_text(encoding='utf-8').replace('{VER}', VER), encoding='utf-8')
readme = (SKILL / 'README.md').read_text(encoding='utf-8')
for a, b in [('](docs/', '](zpboom-3d-previs/docs/'), ('](references/', '](zpboom-3d-previs/references/'), ('](LICENSE.txt)', '](zpboom-3d-previs/LICENSE.txt)'), ('](CHANGELOG.md)', '](zpboom-3d-previs/CHANGELOG.md)')]:
    readme = readme.replace(a, b)
(stage / 'README.md').write_text(readme, encoding='utf-8')
cl = (SKILL / 'CHANGELOG.md').read_text(encoding='utf-8'); sec = cl[cl.index('\n## ') + 1:]; sec = sec[:sec.find('\n## ', 1)] if '\n## ' in sec[1:] else sec
man = json.loads((BASE / 'manifest_base.json').read_text(encoding='utf-8'))
man.update(version=VER, date=datetime.date.today().isoformat(), changes=[l[2:].strip() for l in sec.splitlines() if l.startswith('- ')])
man['files'] = [{'path': p.relative_to(stage).as_posix(), 'bytes': p.stat().st_size, 'sha256': hashlib.sha256(p.read_bytes()).hexdigest()} for p in sorted(stage.rglob('*')) if p.is_file()]
(stage / '交付清单.json').write_text(json.dumps(man, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
outer = OUT / f'{NAME}.zip'
if outer.exists(): outer.unlink()
zipdir(outer, OUT, NAME)
print(outer, f'{outer.stat().st_size / 1e6:.1f} MB', len(man['files']), 'files')
