import { http } from '@kit.NetworkKit';
import { webSocket } from '@kit.NetworkKit';

class Role {
  id: string = '';
  name: string = '';
  description: string = '';
  skillExcerpt: string = '';
}

@Entry
@Component
struct Index {
  @State tab: number = 0;
  @State host: string = 'http://127.0.0.1:8800';
  @State workspaceName: string = '组织';
  @State lead: string = '正在读取组织…';
  @State roles: Role[] = [];
  @State selected: Role | null = null;
  @State status: string = '尚未连接电脑';
  @State summary: string = '';
  @State paired: boolean = false;
  @State code: string = '';
  @State command: string = '';
  private socket: webSocket.WebSocket | null = null;
  private deviceToken: string = '';

  aboutToAppear(): void {
    this.loadOrg();
  }

  loadOrg(): void {
    let request = http.createHttp();
    request.request(this.host.replace(/\/$/, '') + '/api/mobile/workspace', {
      method: http.RequestMethod.GET,
    }, (err: Error, data: http.HttpData) => {
      if (err || data.responseCode !== 200) {
        this.lead = '组织预览读不到';
        return;
      }
      const body = JSON.parse(data.result.toString());
      this.workspaceName = body.name as string;
      this.lead = (body.description as string) || '示例组织只读预览';
      const list: Role[] = [];
      const raw = body.roles as Object[];
      for (let i = 0; i < raw.length; i++) {
        const item = raw[i] as Record<string, string>;
        const role = new Role();
        role.id = item.id;
        role.name = item.name;
        role.description = item.description;
        role.skillExcerpt = item.skillExcerpt;
        list.push(role);
      }
      this.roles = list;
    });
  }

  pair(): void {
    this.status = '正在配对…';
    let request = http.createHttp();
    request.request(this.host.replace(/\/$/, '') + '/phone-link/v1/pair', {
      method: http.RequestMethod.POST,
      extraData: JSON.stringify({ code: this.code }),
      header: { 'Content-Type': 'application/json' },
    }, (err: Error, data: http.HttpData) => {
      if (err || data.responseCode !== 200) {
        this.status = '配对失败';
        return;
      }
      const body = JSON.parse(data.result.toString());
      this.deviceToken = body.deviceToken as string;
      this.connectSocket();
    });
  }

  connectSocket(): void {
    const wsUrl = this.host.replace('https://', 'wss://').replace('http://', 'ws://').replace(/\/$/, '') +
      '/phone-link/phone';
    this.socket = webSocket.createWebSocket();
    this.socket.connect(wsUrl, (err: Error, _value: boolean) => {
      if (err) {
        this.status = '连接失败';
        return;
      }
      this.socket?.send(JSON.stringify({ v: 1, type: 'phone.hello', deviceToken: this.deviceToken }));
    });
    this.socket.on('message', (_err: Error, value: string | ArrayBuffer) => {
      const body = JSON.parse(value.toString());
      if (body.type === 'phone.accepted') {
        this.paired = true;
        this.status = '已连上电脑，可以发指令。';
      } else if (body.type === 'command.status') {
        const labels: Record<string, string> = {
          accepted: '电脑已接到',
          running: '员工正在处理',
          completed: '完成',
          failed: '失败',
          busy: '该员工正在忙',
          needs_approval: '请在电脑上确认',
        };
        this.status = labels[body.state as string] ?? body.state as string;
        if (body.summary) {
          this.summary = body.summary as string;
        }
      }
    });
  }

  send(): void {
    if (!this.paired || this.socket === null) {
      this.status = '还没连上电脑';
      return;
    }
    this.socket.send(JSON.stringify({
      v: 1,
      type: 'command.submit',
      commandId: `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`,
      text: this.command,
      positionId: this.roles.length > 0 ? this.roles[0].id : undefined,
    }));
    this.status = '已发出，等电脑受理…';
    this.command = '';
  }

  @Builder
  orgPage() {
    Column() {
      Text(this.workspaceName).fontSize(26).fontWeight(FontWeight.Bold).width('100%')
      Text(this.lead).fontSize(14).fontColor('#B7B0C2').margin({ top: 8, bottom: 12 }).width('100%')
      if (this.selected) {
        Column({ space: 8 }) {
          Text(this.selected.name).fontSize(20).fontWeight(FontWeight.Medium)
          Text(this.selected.description)
          Text(this.selected.skillExcerpt.length > 0 ? this.selected.skillExcerpt : '没有摘录')
            .fontSize(12).fontColor('#B7B0C2')
          Button('返回').onClick(() => { this.selected = null; })
        }
        .width('100%')
        .padding(16)
        .borderRadius(20)
        .backgroundColor('#221F28')
      } else {
        List({ space: 12 }) {
          ForEach(this.roles, (role: Role) => {
            ListItem() {
              Column({ space: 6 }) {
                Text(role.name).fontSize(18).fontWeight(FontWeight.Medium)
                Text(role.description).fontSize(13).fontColor('#B7B0C2')
              }
              .width('100%')
              .padding(18)
              .borderRadius(20)
              .backgroundColor('#221F28')
              .onClick(() => { this.selected = role; })
            }
          })
        }
        .width('100%')
        .layoutWeight(1)
      }
    }
    .padding(16)
    .width('100%')
    .height('100%')
  }

  @Builder
  commandPage() {
    Column({ space: 12 }) {
      Text('指令').fontSize(26).fontWeight(FontWeight.Bold).width('100%')
      TextInput({ placeholder: 'RoleWeave 地址', text: this.host })
        .onChange((value: string) => { this.host = value; })
      Text(this.status).fontColor('#B7B0C2')
      if (!this.paired) {
        TextInput({ placeholder: '6 位配对码', text: this.code })
          .onChange((value: string) => { this.code = value; })
        Button('配对这台电脑').width('100%').onClick(() => { this.pair(); })
      } else {
        TextArea({ placeholder: '例如：看一下还开着的 PR', text: this.command })
          .onChange((value: string) => { this.command = value; })
        Button('发给电脑').width('100%').onClick(() => { this.send(); })
      }
      if (this.summary.length > 0) {
        Text(this.summary)
      }
    }
    .padding(16)
    .width('100%')
    .height('100%')
  }

  @Builder
  settingsPage() {
    Column({ space: 12 }) {
      Text('设置').fontSize(26).fontWeight(FontWeight.Bold).width('100%')
      Text('平台  HarmonyOS')
      Text('回合  在电脑上执行')
      Text('组织  只读预览')
    }
    .padding(16)
    .width('100%')
    .height('100%')
  }

  build() {
    Column() {
      if (this.tab === 0) {
        this.orgPage()
      } else if (this.tab === 1) {
        this.commandPage()
      } else {
        this.settingsPage()
      }
      Row() {
        Button('组织').layoutWeight(1).onClick(() => { this.tab = 0; })
        Button('指令').layoutWeight(1).onClick(() => { this.tab = 1; })
        Button('设置').layoutWeight(1).onClick(() => { this.tab = 2; })
      }
      .width('100%')
      .padding(8)
    }
    .width('100%')
    .height('100%')
    .backgroundColor('#16141A')
  }
}
