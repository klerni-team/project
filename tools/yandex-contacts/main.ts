import {join} from 'node:path';
import {parseArgs} from 'node:util';
import {formatBBox, parseBBox, StopError, YandexApi, type BBox} from './api.ts';
import {collect, findCity, type SearchLimits} from './collect.ts';
import {safeFileName} from './csv.ts';
import {selectNiches} from './niches.ts';

export const USAGE = `Сбор контактов организаций с Яндекс Карт по нишам.

  node tools/yandex-contacts/cli.ts --city "Казань" [опции]

  --city <город>         город (его границы ищутся через API)
  --out <папка>          куда писать CSV (по умолчанию contacts/<город>)
  --niche <номер|текст>  только эти ниши: 4 (группа), 04-02 (ниша) или часть названия; можно несколько раз
  --bbox <lon1,lat1~lon2,lat2>  область поиска вместо границ города
  --delay <мс>           пауза между запросами к API (по умолчанию 500)
  --max-requests <N>     не больше N запросов к API за запуск (ответы из кеша не считаются)
  --api-key <ключ>       ключ API (по умолчанию YANDEX_SEARCH_API_KEY)
  --list                 показать ниши и выйти
`;

export interface MainDeps {
  env: Record<string, string | undefined>;
  log: (msg: string) => void;
  error: (msg: string) => void;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  limits?: SearchLimits;
}

/** Exit codes: 0 done, 1 bad usage or failure, 2 stopped early (rerun to continue). */
export async function main(argv: string[], deps: MainDeps): Promise<number> {
  let args;
  try {
    args = parseArgs({
      args: argv,
      options: {
        city: {type: 'string'},
        out: {type: 'string'},
        niche: {type: 'string', multiple: true},
        bbox: {type: 'string'},
        delay: {type: 'string'},
        'max-requests': {type: 'string'},
        'api-key': {type: 'string'},
        list: {type: 'boolean'},
        help: {type: 'boolean', short: 'h'},
      },
    }).values;
  } catch (err) {
    deps.error(`${(err as Error).message}\n\n${USAGE}`);
    return 1;
  }
  if (args.help) {
    deps.log(USAGE);
    return 0;
  }

  let niches;
  let bbox: BBox | undefined;
  try {
    niches = selectNiches(args.niche ?? []);
    if (args.bbox) bbox = parseBBox(args.bbox);
  } catch (err) {
    deps.error((err as Error).message);
    return 1;
  }
  if (args.list) {
    let group = '';
    for (const n of niches) {
      if (n.group !== group) deps.log(`${group ? '\n' : ''}${n.code.slice(0, 2)} ${group = n.group}`);
      deps.log(`  ${n.code}  ${n.title}  [${n.queries.join(', ')}]`);
    }
    return 0;
  }

  const city = args.city?.trim();
  if (!city) {
    deps.error(`укажите --city\n\n${USAGE}`);
    return 1;
  }
  const apiKey = args['api-key'] ?? deps.env.YANDEX_SEARCH_API_KEY ?? '';
  if (!apiKey) {
    deps.error('нет ключа API: задайте YANDEX_SEARCH_API_KEY или --api-key (как получить — tools/yandex-contacts/README.md)');
    return 1;
  }
  const delayMs = count(args.delay, 500);
  const maxRequests = count(args['max-requests'], Infinity);
  if (delayMs === null || maxRequests === null) {
    deps.error('--delay и --max-requests должны быть целыми числами ≥ 0');
    return 1;
  }

  const outDir = args.out ?? join('contacts', safeFileName(city));
  const api = new YandexApi({apiKey, cacheDir: join(outDir, '.cache'), fetch: deps.fetch, sleep: deps.sleep, delayMs, maxRequests});
  let stop: StopError | null = null;
  try {
    bbox ??= await findCity(api, city);
    deps.log(`${city}: область ${formatBBox(bbox)}, ниш ${niches.length}, папка ${outDir}`);
    const result = await collect({api, bbox, niches, outDir, limits: deps.limits, log: deps.log});
    stop = result.stop;
    if (result.truncated.length) {
      deps.log(`\nВнимание: в нишах ${result.truncated.join(', ')} часть участков упёрлась в потолок выдачи API, список может быть неполным.`);
    }
    if (stop) {
      deps.log(`\nЗаписано файлов: ${result.files.length}. Не завершены ниши: ${result.unfinished.join(', ')}.`);
    }
  } catch (err) {
    if (!(err instanceof StopError)) {
      deps.error(`ошибка: ${(err as Error).message}`);
      return 1;
    }
    stop = err;
  } finally {
    deps.log(`Запросов к API: ${api.requests}, из кеша: ${api.cacheHits}.`);
  }
  if (!stop) {
    deps.log('Готово.');
    return 0;
  }
  deps.error(`Остановлено: ${stop.message}.\n${NEXT_STEP[stop.reason]}`);
  return 2;
}

const RERUN = 'Запустите ту же команду снова — уже полученные ответы возьмутся из кеша, сбор продолжится с места остановки.';

const NEXT_STEP: Record<StopError['reason'], string> = {
  quota: `Проверьте ключ; если он верный, суточная квота кончилась. ${RERUN.replace('снова', 'завтра (или с другим ключом)')}`,
  rate: `Подождите и увеличьте паузу --delay. ${RERUN}`,
  budget: RERUN,
  error: `Проверьте сеть. ${RERUN}`,
};

function count(v: string | undefined, fallback: number): number | null {
  if (v === undefined) return fallback;
  return /^\d+$/.test(v) ? Number(v) : null;
}
