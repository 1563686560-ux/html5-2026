from pathlib import Path
from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    BaseDocTemplate, Frame, PageTemplate, Paragraph, Spacer, Table, TableStyle, PageBreak, KeepTogether
)

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "output" / "pdf" / "知识库复杂PDF验收样本.pdf"
OUT.parent.mkdir(parents=True, exist_ok=True)

font = Path("C:/Windows/Fonts/msyh.ttc")
bold = Path("C:/Windows/Fonts/msyhbd.ttc")
pdfmetrics.registerFont(TTFont("CN", str(font), subfontIndex=0))
pdfmetrics.registerFont(TTFont("CN-Bold", str(bold), subfontIndex=0))

styles = getSampleStyleSheet()
body = ParagraphStyle("BodyCN", parent=styles["BodyText"], fontName="CN", fontSize=10.5,
                      leading=18, textColor=colors.HexColor("#25313D"), spaceAfter=8)
h1 = ParagraphStyle("H1CN", parent=styles["Heading1"], fontName="CN-Bold", fontSize=20,
                    leading=28, textColor=colors.HexColor("#126B62"), spaceAfter=14)
h2 = ParagraphStyle("H2CN", parent=styles["Heading2"], fontName="CN-Bold", fontSize=13,
                    leading=20, textColor=colors.HexColor("#184E49"), spaceBefore=8, spaceAfter=8)
small = ParagraphStyle("SmallCN", parent=body, fontSize=8.5, leading=13, textColor=colors.HexColor("#60717F"))
title = ParagraphStyle("TitleCN", parent=h1, alignment=TA_CENTER, fontSize=24, leading=34)

def header_footer(canvas, doc):
    canvas.saveState()
    canvas.setFont("CN", 8.5)
    canvas.setFillColor(colors.HexColor("#6C7A86"))
    canvas.drawString(20 * mm, 286 * mm, "苍穹实验室 - 复杂 PDF 知识库验收样本")
    canvas.drawRightString(190 * mm, 12 * mm, f"第 {doc.page} 页")
    canvas.setStrokeColor(colors.HexColor("#D9E4E2"))
    canvas.line(20 * mm, 282 * mm, 190 * mm, 282 * mm)
    canvas.restoreState()

doc = BaseDocTemplate(str(OUT), pagesize=A4, rightMargin=20*mm, leftMargin=20*mm,
                      topMargin=19*mm, bottomMargin=20*mm, title="复杂PDF知识库验收样本")
frame = Frame(doc.leftMargin, doc.bottomMargin, doc.width, doc.height, id="body")
doc.addPageTemplates(PageTemplate(id="main", frames=[frame], onPage=header_footer))

story = [
    Spacer(1, 18*mm),
    Paragraph("苍穹实验室设备开放日", title),
    Paragraph("复杂 PDF 知识库验收样本（全部内容为虚构测试设定）", ParagraphStyle(
        "Subtitle", parent=body, alignment=TA_CENTER, fontSize=11, textColor=colors.HexColor("#60717F"))),
    Spacer(1, 12*mm),
    Paragraph("使用说明", h2),
    Paragraph("本文件用于验证 PDF 文本提取、表格问答、跨页语义和页眉页脚干扰。活动日期、人员、费用和设备参数均为虚构，不得当作真实信息。", body),
    Paragraph("核心规则摘要", h2),
    Paragraph("开放日定于 2027 年 3 月 18 日，地点为澄明馆三层。报名截止时间为 2027 年 3 月 2 日 18:00。每队 2 至 4 人，不收报名费。项目负责人为顾言。", body),
    Paragraph("提交材料", h2),
    Paragraph("每队提交源码压缩包、六页以内的说明文档和不超过五分钟的演示视频。源码中不得包含真实 API 密钥。现场演示失败不会自动取消资格，但必须用测试记录说明已经完成的部分。", body),
    PageBreak(),
    Paragraph("一、设备预约表", h1),
]

data = [[Paragraph(x, small) for x in ["设备", "可用时段", "每队上限", "押金", "负责人"]],
        [Paragraph(x, small) for x in ["星轨投影仪", "09:00-11:30", "30 分钟", "200 元", "许棠"]],
        [Paragraph(x, small) for x in ["微光传感器", "13:00-16:00", "45 分钟", "无需押金", "陆川"]],
        [Paragraph(x, small) for x in ["云镜展示屏", "全天", "60 分钟", "500 元", "顾言"]]]
table = Table(data, colWidths=[35*mm, 38*mm, 28*mm, 28*mm, 25*mm], repeatRows=1)
table.setStyle(TableStyle([
    ("FONTNAME", (0,0), (-1,-1), "CN"), ("BACKGROUND", (0,0), (-1,0), colors.HexColor("#126B62")),
    ("TEXTCOLOR", (0,0), (-1,0), colors.white), ("GRID", (0,0), (-1,-1), .5, colors.HexColor("#B9CECA")),
    ("VALIGN", (0,0), (-1,-1), "MIDDLE"), ("ROWBACKGROUNDS", (0,1), (-1,-1), [colors.white, colors.HexColor("#F2F7F6")]),
    ("LEFTPADDING", (0,0), (-1,-1), 6), ("RIGHTPADDING", (0,0), (-1,-1), 6),
    ("TOPPADDING", (0,0), (-1,-1), 8), ("BOTTOMPADDING", (0,0), (-1,-1), 8),
]))
story += [table, Spacer(1, 6*mm), Paragraph("预约规则", h2),
          Paragraph("预约在开放日前三天关闭。迟到超过十分钟会释放设备。只有云镜展示屏需要在预约时填写视频接口类型。表格中的押金在设备无损归还后原路退回；微光传感器不收押金。", body),
          Paragraph("干扰说明", h2),
          Paragraph("页眉中的“复杂 PDF 知识库验收样本”是文档标识，不是活动名称；页码也不属于正文事实。回答时应优先使用正文和表格。", body),
          Spacer(1, 48*mm),
          Paragraph("二、跨页安全流程", h1),
          Paragraph("领取设备后，团队先核对封签编号和配件数量，再在登记表签字。若发现配件缺失，应在通电之前通知负责人并拍照记录。设备运行时不得遮挡散热口，也不得在潮湿环境中连接电源。为了验证跨页段落提取，本段的关键结论故意放在下一页：", body),
          PageBreak(),
          Paragraph("只有完成关机、断电、线缆归位和负责人验收这四个步骤，押金才会退回。仅关闭屏幕不算完成归还。星轨投影仪由许棠验收，云镜展示屏由顾言验收。", body),
          Paragraph("三、预算与奖项", h1),
          Paragraph("展示物料预算上限为 2400 元，可用于展板印刷、展签和无障碍说明卡，不包含交通费、餐费和设备押金。活动设置“最佳可用性”与“最佳资料依据”两个奖项；每个获奖团队领取证书和 400 元奖金。", body),
          Paragraph("四、未提供的信息", h1),
          Paragraph("本文件没有提供顾言的电话号码、参观人数上限、午餐菜单和停车费用。回答这些问题时应明确说明资料不足，不得根据地点、负责人姓名或其他活动推测。", body),
          Paragraph("五、连续追问提示", h1),
          Paragraph("当用户先询问云镜展示屏的押金，再追问“什么时候退回”时，后一个问题仍指云镜展示屏。答案应结合表格与跨页安全流程：押金为 500 元，完成关机、断电、线缆归位和负责人验收后原路退回。", body),
          KeepTogether([Paragraph("验收结束", h2), Paragraph("如果系统能够正确回答表格、跨页结论、资料不足和连续追问问题，并能展示对应原文，说明本样本的主要验收目标已经覆盖。", body)])]

doc.build(story)
print(OUT)
