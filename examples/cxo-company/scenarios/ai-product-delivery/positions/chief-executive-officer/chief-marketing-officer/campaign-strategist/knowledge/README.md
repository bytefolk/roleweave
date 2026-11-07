# 已批准的合成案例资料

【合成任务】一家虚构的三人内容团队需要 AI 选题助手的 MVP 交付包。界面输入三个选题关键词，生成五条选题建议，每条包含标题、适用受众、依据与待验证项；空输入要给出明确错误说明。不接入真实模型或客户系统。当前岗位只读：研究、规格、接口、代码草稿、审阅和验收说明均在会话中交付，不写文件、不发布、不部署。

## 用户验收项

- 区分合成需求、已知事实与待验证假设
- 产品规格包含正常输入、空输入、错误状态和最小范围
- 前后端代码草稿与同一接口契约一致，缺少真实运行证据的检查标为 NOT_VERIFIED
- 审阅 FAIL 明确问题、证据和修复目标，由用户决定是否发起修复与复验
- 市场内容只使用确认过的产品能力，增长结果仍待验证
- 交付运营团队汇总所有产物、阻塞项和用户验收清单，最终验收归用户

岗位默认仅有此知识目录的读取权限。全部客户与业务材料均为虚构示例；不包含凭据或真实客户资料。

## 本岗位的团队与阶段

[
  {
    "team": "市场团队",
    "sponsor": "chief-marketing-officer",
    "lead": "campaign-strategist",
    "members": [
      "campaign-strategist",
      "content-creator",
      "growth-analyst"
    ],
    "runbook": {
      "id": "market-validation",
      "teamId": "marketing",
      "name": "市场定位、内容与增长实验",
      "sources": [
        "method-agency"
      ],
      "stages": [
        {
          "id": "campaign-drafts",
          "mode": "parallel",
          "mentions": [
            "content-creator",
            "growth-analyst"
          ],
          "instruction": "用户提供已确认的产品范围；内容策划编写内容草稿，增长分析师提出渠道实验和测量方案。不得虚构评价、增长或转化数据。",
          "outputs": [
            "campaign-content",
            "growth-experiment"
          ],
          "acceptance": [
            "没有虚假效果承诺",
            "发布和投放均未执行"
          ]
        },
        {
          "id": "campaign-review",
          "mode": "relay",
          "mentions": [
            "growth-analyst",
            "campaign-strategist"
          ],
          "instruction": "用户提供内容和实验草稿；分析师核对指标与假设，负责人整合活动方案、检查事实表述与品牌一致性。",
          "outputs": [
            "measurement-review",
            "campaign-plan"
          ],
          "acceptance": [
            "指标、受众和范围一致",
            "未知项有后续验证方法"
          ]
        }
      ],
      "finalReview": {
        "reviewers": [
          "campaign-strategist"
        ],
        "criteria": [
          "内容仅使用已确认能力",
          "实验方法明确，结果仍待验证"
        ],
        "decisionOwner": "operator"
      }
    }
  }
]

用户显式发起每个阶段。回合 completed 不等于验收 PASS；没有运行证据的检查标为 NOT_VERIFIED。修复最多 3 次，达到上限后交给用户决定。

## 交接要求

交接保留目标、产物、证据、约束、未解决项、下一阶段请求及验收标准。跨群组的关键产物由用户审阅后放进下一阶段输入，不隐式共享。
