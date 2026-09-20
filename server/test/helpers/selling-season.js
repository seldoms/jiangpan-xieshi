import { beforeEach, afterEach, mock } from 'node:test';

// 通用订单夹具固定在公母均开售的日期；停售边界由 spec-sold-out 单独覆盖。
beforeEach(() => mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-02T04:00:00Z') }));
afterEach(() => mock.timers.reset());
