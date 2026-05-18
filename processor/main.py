import re
import html
import json
import io
import os
import smtplib
from email.mime.multipart import MIMEMultipart
from email.mime.base import MIMEBase
from email.mime.text import MIMEText
from email import encoders

import openpyxl
from fastapi import FastAPI, UploadFile
from fastapi.responses import JSONResponse
from reportlab.lib.pagesizes import A4
from reportlab.lib import colors
from reportlab.platypus import SimpleDocTemplate, Table, TableStyle, Paragraph, Spacer
from reportlab.lib.styles import getSampleStyleSheet

app = FastAPI()

GS = '\x1d'

# ── Парсеры ──────────────────────────────────────────────

def extract_code(raw: str) -> str | None:
    code = raw.split(GS)[0].strip()
    return code if len(code) >= 19 else None

def parse_xml(content: bytes) -> list[str]:
    text = content.decode('utf-8')
    pattern = r'<catESAD_cu:IdentifacationMeansUnitCharacterValueId>(.*?)</catESAD_cu:IdentifacationMeansUnitCharacterValueId>'
    raw_codes = re.findall(pattern, text, re.DOTALL)
    codes = []
    for code in raw_codes:
        parsed = extract_code(html.unescape(code.strip()))
        if parsed:
            codes.append(parsed)
    return codes

def parse_csv(content: bytes) -> list[str]:
    text = content.decode('utf-8-sig')
    codes = []
    for i, line in enumerate(text.splitlines()):
        line = line.strip()
        if not line:
            continue
        first_col = line.split('\t')[0].strip()
        if i == 0 and first_col and not first_col[0].isdigit():
            continue
        code = extract_code(first_col)
        if code:
            codes.append(code)
    return codes

def parse_xls(content: bytes) -> list[str]:
    wb = openpyxl.load_workbook(io.BytesIO(content), read_only=True, data_only=True)
    ws = wb.active
    codes = []
    for i, row in enumerate(ws.iter_rows(values_only=True)):
        val = row[0] if row else None
        if val is None:
            continue
        val = str(val).strip()
        if i == 0 and val and not val[0].isdigit():
            continue
        code = extract_code(val)
        if code:
            codes.append(code)
    return codes

# ── Агрегация ────────────────────────────────────────────

def fmt_date(d: str | None) -> str:
    if not d:
        return ''
    return d[:7]

def aggregate(items: list[dict]) -> dict:
    by_status = {}
    by_owner = {}
    by_product_group = {}
    by_brand = {}
    by_emission_date = {}
    by_produced_date = {}
    not_found = 0
    errors = {}

    for item in items:
        status = item.get('status') or 'NOT_FOUND'
        by_status[status] = by_status.get(status, 0) + 1

        err_code = item.get('errorCode')
        if err_code:
            errors[err_code] = errors.get(err_code, 0) + 1

        if status == 'NOT_FOUND':
            not_found += 1
            continue

        owner = item.get('ownerName')
        if owner:
            by_owner[owner] = by_owner.get(owner, 0) + 1

        pg = item.get('productGroup')
        if pg:
            by_product_group[pg] = by_product_group.get(pg, 0) + 1

        brand = item.get('brand')
        if brand:
            by_brand[brand] = by_brand.get(brand, 0) + 1

        em = fmt_date(item.get('emissionDate'))
        if em:
            by_emission_date[em] = by_emission_date.get(em, 0) + 1

        pr = fmt_date(item.get('producedDate'))
        if pr:
            by_produced_date[pr] = by_produced_date.get(pr, 0) + 1

    total = len(items)
    return {
        'total': total,
        'found': total - not_found,
        'notFound': not_found,
        'byStatus': dict(sorted(by_status.items(), key=lambda x: -x[1])),
        'byOwner': dict(sorted(by_owner.items(), key=lambda x: -x[1])[:50]),
        'byProductGroup': dict(sorted(by_product_group.items(), key=lambda x: -x[1])),
        'byBrand': dict(sorted(by_brand.items(), key=lambda x: -x[1])[:50]),
        'byEmissionDate': dict(sorted(by_emission_date.items())),
        'byProducedDate': dict(sorted(by_produced_date.items())),
        'errors': dict(sorted(errors.items(), key=lambda x: -x[1])),
    }

# ── PDF ──────────────────────────────────────────────────

HEADER_COLOR = colors.HexColor('#0051c3')
ROW_COLORS = [colors.white, colors.HexColor('#f5f5f5')]

def make_table(data, col_widths):
    t = Table(data, colWidths=col_widths, repeatRows=1)
    t.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, 0), HEADER_COLOR),
        ('TEXTCOLOR', (0, 0), (-1, 0), colors.white),
        ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
        ('FONTNAME', (0, 1), (-1, -1), 'Helvetica'),
        ('FONTSIZE', (0, 0), (-1, -1), 8),
        ('GRID', (0, 0), (-1, -1), 0.4, colors.grey),
        ('ROWBACKGROUNDS', (0, 1), (-1, -1), ROW_COLORS),
        ('PADDING', (0, 0), (-1, -1), 4),
        ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
    ]))
    return t

def section(elements, title, data, col_widths, styles):
    elements.append(Paragraph(title, styles['Heading2']))
    elements.append(Spacer(1, 4))
    elements.append(make_table(data, col_widths))
    elements.append(Spacer(1, 14))

def generate_pdf(job_id: str, summary: dict) -> bytes:
    buf = io.BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=A4,
                            rightMargin=35, leftMargin=35,
                            topMargin=35, bottomMargin=35)
    styles = getSampleStyleSheet()
    el = []

    el.append(Paragraph('Report: Codes Check', styles['Title']))
    el.append(Paragraph(f'Job ID: {job_id}', styles['Normal']))
    el.append(Spacer(1, 14))

    section(el, 'Summary', [
        ['Parameter', 'Value'],
        ['Total codes', str(summary['total'])],
        ['Found', str(summary['found'])],
        ['Not found', str(summary['notFound'])],
    ], [330, 150], styles)

    if summary['byStatus']:
        section(el, 'By status',
            [['Status', 'Count']] +
            [[k, str(v)] for k, v in summary['byStatus'].items()],
            [330, 150], styles)

    if summary.get('errors'):
        section(el, 'API errors',
            [['Error code', 'Count']] +
            [[k, str(v)] for k, v in summary['errors'].items()],
            [330, 150], styles)

    if summary['byProductGroup']:
        section(el, 'By product group',
            [['Group', 'Count']] +
            [[k, str(v)] for k, v in summary['byProductGroup'].items()],
            [330, 150], styles)

    if summary['byOwner']:
        section(el, 'By owner (top 50)',
            [['Owner', 'Count']] +
            [[k, str(v)] for k, v in summary['byOwner'].items()],
            [380, 100], styles)

    if summary['byBrand']:
        section(el, 'By brand (top 50)',
            [['Brand', 'Count']] +
            [[k, str(v)] for k, v in summary['byBrand'].items()],
            [380, 100], styles)

    if summary['byEmissionDate']:
        section(el, 'By emission date',
            [['Month', 'Count']] +
            [[k, str(v)] for k, v in summary['byEmissionDate'].items()],
            [330, 150], styles)

    if summary['byProducedDate']:
        section(el, 'By production date',
            [['Month', 'Count']] +
            [[k, str(v)] for k, v in summary['byProducedDate'].items()],
            [330, 150], styles)

    doc.build(el)
    return buf.getvalue()

# ── Email ────────────────────────────────────────────────

def send_email_report(to: str, job_id: str, summary: dict, pdf_bytes: bytes,
                      smtp_host: str, smtp_port: int, smtp_user: str,
                      smtp_pass: str, smtp_from: str):
    msg = MIMEMultipart()
    msg['From'] = smtp_from
    msg['To'] = to
    msg['Subject'] = f'Codes check report - {summary["total"]} records'

    body = (
        f'Processing complete.\n\n'
        f'Total codes: {summary["total"]}\n'
        f'Found:       {summary["found"]}\n'
        f'Not found:   {summary["notFound"]}\n\n'
        f'Full report attached.'
    )
    msg.attach(MIMEText(body, 'plain', 'utf-8'))

    part = MIMEBase('application', 'pdf')
    part.set_payload(pdf_bytes)
    encoders.encode_base64(part)
    part.add_header('Content-Disposition', f'attachment; filename="report-{job_id}.pdf"')
    msg.attach(part)

    with smtplib.SMTP(smtp_host, smtp_port) as srv:
        srv.starttls()
        srv.login(smtp_user, smtp_pass)
        srv.send_message(msg)

# ── Endpoints ────────────────────────────────────────────

@app.post('/parse')
async def parse_file(file: UploadFile):
    """Принимает файл, возвращает массив кодов"""
    content = await file.read()
    name = file.filename.lower()

    if name.endswith('.xml'):
        codes = parse_xml(content)
    elif name.endswith(('.xlsx', '.xls')):
        codes = parse_xls(content)
    elif name.endswith(('.csv', '.txt')):
        codes = parse_csv(content)
    else:
        return JSONResponse({'error': f'Unsupported format: {name}'}, status_code=400)

    codes = list(dict.fromkeys(codes))
    return {'codes': codes, 'count': len(codes)}


@app.post('/generate-report')
async def generate_report(payload: dict):
    """Принимает items от CRPT, возвращает PDF как base64 + summary"""
    import base64

    job_id = payload['jobId']
    items = payload['items']
    email = payload.get('email')
    smtp = payload.get('smtp')

    summary = aggregate(items)
    pdf_bytes = generate_pdf(job_id, summary)

    if email and smtp:
        try:
            send_email_report(
                to=email,
                job_id=job_id,
                summary=summary,
                pdf_bytes=pdf_bytes,
                smtp_host=smtp['host'],
                smtp_port=int(smtp['port']),
                smtp_user=smtp['user'],
                smtp_pass=smtp['pass'],
                smtp_from=smtp['from'],
            )
        except Exception as e:
            print(f'Email error: {e}')

    return {
        'summary': summary,
        'pdf': base64.b64encode(pdf_bytes).decode('utf-8')
    }


@app.get('/health')
async def health():
    return {'ok': True}
