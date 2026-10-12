import { describe, expect, it } from 'vitest'
import {
  CATEGORIES,
  CATEGORY_GROUPS,
  PERSONAS,
  SAGES,
  accentFor,
  buildCustomPersona,
  buildTempPersona,
  categoryMeta,
  getPersona,
  groupOf,
  groupPersonas,
  isSage,
  toLines,
  type PersonaCategory
} from './personas'

describe('内置角色数据', () => {
  it('id 全局唯一', () => {
    const ids = PERSONAS.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('每个角色都有能进提示词的实质内容', () => {
    for (const persona of PERSONAS) {
      expect(persona.name, persona.id).toBeTruthy()
      expect(persona.avatar, persona.id).toBeTruthy()
      expect(persona.identity.length, persona.id).toBeGreaterThan(10)
      expect(persona.speechStyle.length, persona.id).toBeGreaterThan(0)
      expect(persona.taboos.length, persona.id).toBeGreaterThan(0)
      // knowledgeScope 是必填字段，会被拼进 system prompt 的「你的知识边界」一节。
      // 漏了它 TS 会报错，但 vitest 只剥类型不做检查 —— 所以这里也要断言一次，
      // 否则「类型不过但测试全绿」这种情况会一路混到构建才炸
      expect(persona.knowledgeScope.length, persona.id).toBeGreaterThan(10)
      // 卡片上的主色必须是合法十六进制，否则 --accent 注入后样式会静默失效
      expect(persona.accent, persona.id).toMatch(/^#[0-9a-f]{6}$/i)
    }
  })

  it('全部细分分类都有元数据，且顺序不重复', () => {
    const orders = CATEGORIES.map((c) => c.order)
    expect(new Set(orders).size).toBe(orders.length)
    for (const meta of CATEGORIES) {
      expect(categoryMeta(meta.id).label).toBe(meta.label)
    }
  })

  it('除「我的角色」外，每个内置分类都有角色', () => {
    for (const meta of CATEGORIES) {
      if (meta.id === 'custom') continue
      expect(PERSONAS.filter((p) => p.category === meta.id).length, meta.id).toBeGreaterThan(0)
    }
  })

  it('内置角色的 id 与分类符合契约', () => {
    // 这份名单是数据契约：改了 id 或分类必须同步改这里。
    // 忽略它的代价很隐蔽 —— 老会话里存的是 personaId，
    // id 一改，历史对话就会静默解析成默认助手。
    const expected: Record<PersonaCategory, string[]> = {
      assistant: ['assistant'],
      sage: ['kongzi', 'zhuangzi', 'libai', 'sushi', 'wangyangming', 'luxun', 'einstein', 'socrates'],
      pm: ['pm-review', 'pm-competitor', 'pm-growth'],
      teacher: [
        'teacher-chinese',
        'teacher-math',
        'teacher-english',
        'teacher-physics',
        'teacher-chemistry',
        'teacher-history',
        'teacher-politics',
        'teacher-biology',
        'teacher-cs'
      ],
      operator: ['ops-event', 'ops-copy', 'ops-private', 'ops-data'],
      actor: ['actor-roleplay', 'actor-lines', 'actor-emotion', 'craft-voice'],
      tech: ['tech-backend', 'tech-frontend', 'tech-architect', 'tech-data', 'tech-sre', 'craft-security'],
      design: [
        'design-ux',
        'design-graphic',
        'design-photo',
        'design-screenwriter',
        'design-musician',
        'craft-game',
        'craft-illustrator',
        'craft-space',
        'craft-editor'
      ],
      business: [
        'biz-hr',
        'biz-interviewer',
        'biz-career',
        'biz-sales',
        'biz-founder',
        'work-economist',
        'work-consultant',
        'work-nego'
      ],
      health: [
        'health-doctor',
        'health-nutrition',
        'health-psych',
        'health-fitness',
        'living-tcm',
        'living-dental',
        'living-relationship'
      ],
      law: ['law-lawyer', 'law-contract', 'law-accountant', 'law-wealth', 'work-labor'],
      life: [
        'life-chef',
        'life-travel',
        'life-organizer',
        'life-vet',
        'living-parenting',
        'living-gardener',
        'living-baking'
      ],
      academic: [
        'acad-thesis',
        'acad-abroad',
        'acad-kaoyan',
        'acad-research',
        'study-translator',
        'study-writing',
        'study-science',
        'study-library',
        'study-museum',
        'study-civil'
      ],
      custom: []
    }

    for (const [category, ids] of Object.entries(expected)) {
      for (const id of ids) {
        const found = PERSONAS.find((p) => p.id === id)
        expect(found, `${id} 缺失`).toBeTruthy()
        expect(found?.category, id).toBe(category)
      }
    }

    // 总数也要对上：多出没登记的 id 说明有人绕过契约往库里加了角色
    expect(PERSONAS.length).toBe(Object.values(expected).flat().length)
  })

  it('先贤列表只含先贤，且默认角色是通用助手', () => {
    expect(SAGES.length).toBeGreaterThan(0)
    expect(SAGES.every((p) => p.category === 'sage')).toBe(true)
    expect(getPersona('不存在的 id').id).toBe('assistant')
    expect(isSage('kongzi')).toBe(true)
    expect(isSage('pm-review')).toBe(false)
  })
})

describe('展示分组（分类合并）', () => {
  it('每个细分分类都恰好归属于一个组', () => {
    for (const meta of CATEGORIES) {
      const owners = CATEGORY_GROUPS.filter((group) => group.categories.includes(meta.id))
      expect(owners.length, `${meta.id} 归属了 ${owners.length} 个组`).toBe(1)
      expect(groupOf(meta.id).id).toBe(owners[0].id)
    }
  })

  it('组里没有登记不存在的细分分类', () => {
    const known = new Set(CATEGORIES.map((meta) => meta.id))
    for (const group of CATEGORY_GROUPS) {
      for (const category of group.categories) {
        expect(known.has(category), `${group.id} 引用了未知分类 ${category}`).toBe(true)
      }
    }
  })

  it('组顺序不重复，并按 order 升序排列', () => {
    const orders = CATEGORY_GROUPS.map((group) => group.order)
    expect(new Set(orders).size).toBe(orders.length)
    expect([...orders].sort((a, b) => a - b)).toEqual(orders)
  })

  it('分组后每个角色都恰好出现一次，一个不漏', () => {
    const entries = groupPersonas(PERSONAS)
    const total = entries.reduce((sum, entry) => sum + entry.items.length, 0)
    expect(total).toBe(PERSONAS.length)
    // 「我的角色」没有内置角色，不该凭空出现
    expect(entries.map((entry) => entry.group.id)).not.toContain('custom')
  })

  it('alwaysShow 能让空分组保留下来（「新建角色」入口靠它）', () => {
    const entries = groupPersonas(PERSONAS, ['custom'])
    const custom = entries.find((entry) => entry.group.id === 'custom')
    expect(custom).toBeTruthy()
    expect(custom?.items.length).toBe(0)
  })

  it('合并后 chip 数量明显少于细分分类数', () => {
    expect(CATEGORY_GROUPS.length).toBeLessThan(CATEGORIES.length)
  })

  it('文档口径的三个规模数字与代码一致', () => {
    // 三份文档都拿这三个数说话：
    //   需求文档用「12 个细分领域」与「7 个展示分组」；
    //   开发计划与审查报告另外还引用「14 个细分分类」（含万能对话与我的角色）。
    // 首页能力卡上的领域数也是按 12 算的 —— 一旦有人加减分类或改动分组，
    // 这里会先失败，提醒去同步三份文档，而不是让文档和界面各说各话。
    expect(CATEGORIES.length).toBe(14)
    expect(CATEGORIES.filter((item) => item.id !== 'assistant' && item.id !== 'custom').length).toBe(12)
    expect(CATEGORY_GROUPS.length).toBe(7)
  })
})

describe('toLines 多行输入切分', () => {
  it('去掉空行与首尾空白', () => {
    expect(toLines('  第一行 \n\n  \n第二行\n')).toEqual(['第一行', '第二行'])
  })

  it('全空白得到空数组', () => {
    expect(toLines('   \n  \n')).toEqual([])
  })
})

describe('accentFor 主色分配', () => {
  it('同名同色，稳定可复现', () => {
    expect(accentFor('健身教练')).toBe(accentFor('健身教练'))
  })

  it('总是返回合法十六进制色值', () => {
    for (const name of ['', 'a', '健身教练', 'a-very-long-custom-persona-name']) {
      expect(accentFor(name)).toMatch(/^#[0-9a-f]{6}$/i)
    }
  })
})

describe('buildCustomPersona 自建角色', () => {
  const input = {
    name: '健身教练',
    avatar: '🏋️',
    tagline: '帮我把训练计划排明白',
    identity: '你是一位有十年经验的健身教练。',
    speechStyle: '先问清我的目标\n说人话',
    taboos: '不要编造医学结论'
  }

  it('按分类规则落到「我的角色」组', () => {
    const persona = buildCustomPersona(input, 'persona_1')
    expect(persona.category).toBe('custom')
    expect(persona.origin).toBe('custom')
    expect(persona.era).toBe('我的角色')
  })

  it('多行语气与禁忌被切成数组', () => {
    const persona = buildCustomPersona(input, 'persona_1')
    expect(persona.speechStyle).toEqual(['先问清我的目标', '说人话'])
    expect(persona.taboos).toEqual(['不要编造医学结论'])
  })

  it('缺语气和禁忌时给出兜底，不能是空数组', () => {
    // 空的 speechStyle / taboos 会让提示词少掉两整节约束，等于角色没有边界
    const persona = buildCustomPersona({ ...input, speechStyle: '', taboos: '' }, 'persona_2')
    expect(persona.speechStyle.length).toBeGreaterThan(0)
    expect(persona.taboos.length).toBeGreaterThan(0)
  })

  it('缺头像时兜底为 emoji', () => {
    expect(buildCustomPersona({ ...input, avatar: '  ' }, 'persona_3').avatar).toBe('✨')
  })

  it('没有一句话介绍时，开场白仍然完整', () => {
    const persona = buildCustomPersona({ ...input, tagline: '' }, 'persona_4')
    expect(persona.tagline).toContain('健身教练')
    expect(persona.greeting).toContain('健身教练')
  })
})

describe('buildTempPersona 临时人设', () => {
  it('标记为临时角色并归入「我的角色」组', () => {
    const persona = buildTempPersona('一个毒舌的健身教练', 'temp_1')
    expect(persona.origin).toBe('temp')
    expect(persona.category).toBe('custom')
    expect(persona.era).toBe('临时角色')
  })

  it('把描述写进身份设定，模型才知道要演谁', () => {
    const persona = buildTempPersona('一个毒舌的健身教练', 'temp_1')
    expect(persona.identity).toContain('一个毒舌的健身教练')
  })

  it('过长的描述截断名称，但不丢身份设定', () => {
    const long = '一个说话非常啰嗦而且喜欢绕弯子的健身教练'
    const persona = buildTempPersona(long, 'temp_2')
    expect(persona.name.length).toBeLessThanOrEqual(13)
    expect(persona.identity).toContain(long)
  })
})
