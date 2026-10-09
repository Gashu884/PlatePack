# PlatePack

96ウェルプレートのパッキングを行うUIと、パッキング結果をHTMLレポートとして返すFastAPIを提供します。

## 構成

```
.
├── backend/
│   ├── app.py             # FastAPI
│   └── api/               # HTML生成・ログ永続化
└── frontend/
    ├── home.html          # Home (Packer / Database の入口)
    ├── app.html           # Packer UI
    ├── database.html      # 保存ログ(Database) UI
    └── sample_report.html # 参考HTML
└── vercel.json            # Vercel ルーティング設定
```

## セットアップ

### ローカルで動かす場合

```bash
python -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install -r requirements.txt
uvicorn backend.app:app --reload
```

- UI: `http://localhost:8000/`（`/plates`, `/results` も同一HTMLで表示切替）
- API: `http://localhost:8000/generate-html`
- サンプル: `http://localhost:8000/generate-html/sample`

### Vercel にデプロイする場合

1. リポジトリを Vercel にインポート
2. Build Command / Output Directory は空欄で OK
3. デプロイすると以下が利用できます
   - `https://{your-project}.vercel.app/` → UI
   - `https://{your-project}.vercel.app/generate-html` → HTML 生成エンドポイント (POST)
   - `https://{your-project}.vercel.app/generate-html/sample` → サンプル JSON

## API 仕様

- **HTTP Method:** `POST`
- **Endpoint:** `/generate-html`
- **Headers:** `Content-Type: application/json`
- **Body:** 下記 `ReportRequest` 構造
- **Response:** `text/html; charset=utf-8`

### リクエスト JSON (`ReportRequest`)

```jsonc
{
  "title": "Plates Packing Report",
  "analyst": "A. Analyst",            // 任意
  "run_date": "2024-10-20T15:00:00Z", // 任意 (未指定時は現在時刻)
  "notes": "任意のメモ",
  "sources": [
    {
      "plate_id": "SRC-001",
      "wells": ["A1", "A2", "B1"],
      "description": "Positive controls"
    }
  ],
  "destinations": [
    {
      "plate_id": "DEST-001",
      "rows": 8,
      "cols": 12,
      "assignments": [
        {
          "well": "A1",
          "source_plate": "SRC-001",
          "source_well": "A1",
          "label": "Control A"       // 任意
        }
      ]
    }
  ],
  "plan": [
    {
      "source_plate": "SRC-001",
      "source_well": "A1",
      "destination_plate": "DEST-001",
      "destination_well": "A1"
    }
  ]
}
```

ポイント:
- `sources[].wells` は元のプレートに含まれる陽性ウェル一覧。個数は統計情報に表示されます。
- `destinations[].assignments` は各デスティネーションプレートの配置。`source_plate` / `source_well` を指定すると自動的に凡例とラベルが付きます。
- `plan` を省略した場合は `assignments` から自動生成します。
- ウェル表記は `A1` 形式に対応しています（大文字・小文字は自動で補正）。

### レスポンス例 (冒頭のみ)

```http
HTTP/1.1 200 OK
Content-Type: text/html; charset=utf-8

<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Plates Packing Report</title>
    ...
```

エラー時は `422` (`detail` に原因を含む JSON) が返ります。

## ブラウザコンソールの使い方

1. ブラウザで `http://localhost:8000/` を開く
2. `PlatesPackerへ` からウェル選択・レイアウト設定・パッキングを実行
3. 必要なら `Save Log` でログ保存、`保存したログ` から読み込み/JSONダウンロード

## 増殖週の記録と保存

- 入力プレート上部の `Growth week` に1〜5週目のボタンを常設しています。週を選んでウェルを押すと、その週番号を記録します。
- 選択済みのウェルを別の週で押すと週番号を変更します。同じ週で押すと選択を解除します。行・列の一括選択も選択中の週を記録します。
- パック後は各ウェルの右下に番号を表示します。PNG、TSVの `*_growth_week` 列、HTMLレポートにも週番号を出力します。
- 入力、メモ、レイアウト、週番号、パック結果はブラウザへ自動保存し、再読み込み時に復元します。ブラウザの2種類の保存先に記録し、直前の下書きも保持します。
- `Save Log` はブラウザとDBへの保存を試み、DBから読み戻して内容を確認します。同時にJSONバックアップをダウンロードします。保存に失敗した場合は失敗を表示します。
- `Backup JSON` で任意の時点のデータを書き出し、`Restore JSON` またはDatabaseのインポートで復元できます。従来のversion 1ログも読み込み可能です。
- ブラウザのデータ削除・端末故障に備えて、JSONバックアップは別の場所にも保管してください。ブラウザだけの保存は別端末に引き継がれません。
- VercelのDB保存には既存のPostgreSQLを使用します（`POSTGRES_URL` / `POSTGRES_URL_NON_POOLING` / `DATABASE_URL`）。未設定・接続失敗の場合はDB保存成功と表示せず、`/tmp`の一時DBにも保存しません。`GET /api/storage-health` で利用可否を確認できます。
- 英字フォントはCambriaを優先します。端末にCambriaがない場合はGeorgia等にフォールバックします。

## 検証

```bash
python -m unittest discover -s backend/tests -v
node --test tests/storage.test.cjs
# ローカルサーバー起動後、Playwrightが利用可能な環境で:
BASE_URL=http://127.0.0.1:8000 node tests/e2e.cjs
```

E2Eは週番号の切替、パック、再読み込み、ログ保存の照合、JSON復元、従来データの互換性、PNG/TSV、保存先が利用できない場合を検証します。Chromeを指定する場合は `CHROME_PATH` を設定してください。

## 開発メモ

- HTML レポートは `backend/api/generate_html.py` の `build_html_report` で組み立てています。スタイルや構造を変更したい場合は同関数を編集してください。
- カラーパレットは 12 色を用意しています。ソースプレートが 13 枚以上の場合は再利用されます。
- 追加のバリデーションや表現が必要な場合は Pydantic モデルを拡張して対応してください。
