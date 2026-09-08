# awesome-dsh-plugin 收录 PR 材料(2026-09-09 09:30 后提交,年龄门禁已过)

## 提交步骤
1. `cd D:\CodingProjects\_ref\awesome-pr`(fork 克隆,origin=IKEASven69/awesome-dsh-plugin)
2. `git checkout main && git pull https://github.com/awesome-dsh-plugin/awesome-dsh-plugin.git main`
3. `git checkout -B add-dsh-intelhub`
4. 新建 `data/plugins/IKEASven69__dsh-intelhub.yml`(内容见下)
5. `node scripts/generate-readme.mjs`
6. `git add -A && git commit -m "Add IKEASven69/dsh-intelhub (memory)" && git push -u origin add-dsh-intelhub`
7. `gh pr create --repo awesome-dsh-plugin/awesome-dsh-plugin --head IKEASven69:add-dsh-intelhub --base main --title "Add IKEASven69/dsh-intelhub (memory)" --body "第一个 zvec 原生情报站:采集/文件夹/网页/笔记自动沉淀为可检索知识库,语义+关键词混合检索带出处,Obsidian 反哺,零守护进程零 API key。真库 6342 篇/26412 块实测,检索 100-450ms,换说法查询 6/6 第一名命中。"`
8. 2 分钟后查 Submission gate;若年龄未过再等几小时重推空提交

## yml 内容
```yaml
url: https://github.com/IKEASven69/dsh-intelhub
name: IKEASven69/dsh-intelhub
category: memory
tarball: https://github.com/IKEASven69/dsh-intelhub/releases/download/v0.1.0/dsh-intelhub-0.1.0.tgz
description:
  en: 'Personal intel station: what you scroll past becomes searchable knowledge — social feeds/folders/URLs/notes auto-indexed (zvec in-process, e5-small local embeddings), hybrid semantic+keyword search with source citations, Obsidian refeed, persistent schedules. No daemon, no API key, nothing leaves your machine.'
  zh: '个人情报站:刷到的信息自动沉淀为可检索知识库——社媒采集/文件夹/网页/笔记自动增量索引(zvec 进程内+本地 e5 向量化),语义+关键词混合检索带出处,Obsidian 反哺与持久化定时任务。零守护进程、零 API key、文档不出本机。'
```
