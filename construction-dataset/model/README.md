# Базовая модель интерьеров: Mask2Former Swin Small
Предобученная модель: [facebook/mask2former-swin-small-ade-semantic](https://huggingface.co/facebook/mask2former-swin-small-ade-semantic).
Версия: `717a6bb84e96b508536efed40a8718b6a45cd87c`.
Веса safetensors: 275 606 248 байт. SHA-256: `2533310a1e902580a79e575814f1fa04078a99e2321b9bda7afd4f22bba49189`.

## Возможности и границы
150 классов ADE20K, включая стены, пол, потолок, окна, двери и предметы интерьера.
Результат — карта класса каждого пикселя. Это основа для дообучения, а не готовая модель строительной экспертизы.
Плитка, линолеум, штукатурка, состояние отделки, видимая проводка и её типы требуют дополнительной целевой разметки и обучения.
Цвет можно оценивать внутри маски поверхности с учётом освещения; точный цвет краски по фото не гарантирован.
Скрытую за поверхностью проводку модель по обычному фото не видит.
На нашем датасете этот checkpoint ещё не дообучался. Точность на стройобъектах ещё не измерена.

## Получение и запуск
Веса размещаются в GitHub Releases этого репозитория с тегом `interiors-model-<run_id>` и названием Mask2Former interiors baseline.
Скачайте `mask2former-interiors-baseline.tar.gz`, распакуйте, проверьте хеши:
```bash
tar -xzf mask2former-interiors-baseline.tar.gz
(cd model-package && sha256sum -c SHA256SUMS)
python -m pip install torch==2.8.0 --index-url https://download.pytorch.org/whl/cpu
python -m pip install transformers==4.57.1 pillow==13.0.0 scipy==1.16.3
python construction-dataset/model/baseline.py --model model-package --image interior.jpg --output prediction
```
Выход: `semantic-labels.png` (ID классов, не цветная иллюстрация), `inference-report.json`.
Имена классов в `model-package/labels.json`. Изображение приводится к EXIF-ориентации и стороне не более 1280 px.
Для воспроизводимого скачивания оригинала: `python construction-dataset/model/baseline.py --download`.
Проверка без --image использует синтетический шум: это проверка загрузки весов, вычислений и размеров результата, а не качества распознавания.

## Происхождение и лицензия
Сохранены оригинальная карточка модели, точная ревизия, контрольные суммы и PROVENANCE.json.
В карточке Hugging Face указано `license: other`, без конкретных условий для этого checkpoint.
[Исходный код Meta Mask2Former](https://github.com/facebookresearch/Mask2Former/blob/main/LICENSE) опубликован под MIT; это само по себе не подтверждает лицензию весов.
Коммерческие права на checkpoint не подтверждены. Мы не переобозначаем веса как MIT.
Для коммерческого продукта условия использования весов нужно уточнить у правообладателя.

## Следующий этап
Сверить существующие маски COCO-Stuff и полигоны OpenSurfaces с целевой схемой материалов.
Разделить обучение/проверку по зданиям и источникам, исключить близкие кадры между выборками.
Добавить целевые примеры проводки и отделки, обучить, оценить IoU по классам на независимых размеченных изображениях.
