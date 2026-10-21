// 导入：酒馆角色卡（JSON / PNG）和世界书 JSON。
// 前端把文件读成 base64 传过来；这里识别格式、转换、写库。PNG 卡的图片去掉卡片数据后存为头像。

import type { FastifyInstance } from 'fastify';
import { detectKind, ImportError, importCard, importWorldbook } from '../../core/import/card.ts';
import { cardFromPng, isPng, PngError, stripPngTexts } from '../../core/import/png.ts';
import type { ImportReport } from '../../core/import/report.ts';
import { LibraryError } from '../../core/library.ts';
import type { LibraryStore } from './store.ts';

export interface ImportedItem {
  kind: 'character' | 'worldbook';
  id: string;
  name: string;
  report: ImportReport;
}

export function registerImportRoutes(app: FastifyInstance, store: LibraryStore): void {
  app.post<{ Body: { filename: string; data: string } }>(
    '/api/import',
    {
      schema: {
        body: {
          type: 'object',
          required: ['filename', 'data'],
          properties: { filename: { type: 'string', maxLength: 500 }, data: { type: 'string' } },
        },
      },
    },
    async (req, reply) => {
      const { filename } = req.body;
      const bytes = Buffer.from(req.body.data, 'base64');
      let json: unknown;
      let image: Uint8Array | null = null;
      try {
        if (isPng(bytes)) {
          json = cardFromPng(bytes);
          image = stripPngTexts(bytes, ['chara', 'ccv3']);
        } else {
          json = JSON.parse(bytes.toString('utf8').replace(/^﻿/, ''));
        }
      } catch (e) {
        const message = e instanceof PngError ? e.message : `读不出文件内容：${(e as Error).message}`;
        return reply.code(400).send({ error: 'invalid', message: `${filename}：${message}` });
      }

      try {
        const items: ImportedItem[] = [];
        if (detectKind(json) === 'worldbook') {
          const fallback = filename.replace(/\.[^.]+$/, '') || '导入的世界书';
          const { worldbook, report } = importWorldbook(json, fallback);
          const doc = store.create(req.user, 'worldbook', worldbook as never);
          items.push({ kind: 'worldbook', id: doc.id, name: doc.name, report });
        } else {
          const card = importCard(json);
          const [charReport, bookReport] = card.reports as [ImportReport, ImportReport | undefined];
          let worldbookIds: string[] = [];
          if (card.worldbook) {
            const wb = store.create(req.user, 'worldbook', card.worldbook as never);
            worldbookIds = [wb.id];
            items.push({ kind: 'worldbook', id: wb.id, name: wb.name, report: bookReport! });
          }
          let doc;
          try {
            doc = store.create(req.user, 'character', { ...card.character, worldbookIds } as never);
          } catch (e) {
            // 角色卡没建成时，撤掉刚建的世界书
            for (const id of worldbookIds) store.delete(req.user, 'worldbook', id);
            throw e;
          }
          if (image) {
            store.setAvatar(req.user, doc.id, 'image/png', image);
            charReport.notes.push('PNG 图片已设为头像');
          }
          items.unshift({ kind: 'character', id: doc.id, name: doc.name, report: charReport });
        }
        return reply.code(201).send({ items });
      } catch (e) {
        if (e instanceof ImportError) return reply.code(400).send({ error: 'invalid', message: `${filename}：${e.message}` });
        if (e instanceof LibraryError) return reply.code(400).send({ error: 'invalid', message: `${filename}：转换后的数据没通过校验：${e.message}` });
        throw e;
      }
    },
  );
}
