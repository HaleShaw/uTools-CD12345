/**
 * 会话桥接窗口的 preload
 *
 * 该窗口会加载 www.chengdu.gov.cn 远程页面，远程页面不应获得 Node 能力，
 * 这里主动移除页面上下文中的 require / process 等敏感对象。
 */
try { delete window.require; } catch (e) {}
try { delete window.module; } catch (e) {}
try { delete window.process; } catch (e) {}
try { delete window.global; } catch (e) {}
try { delete window.Buffer; } catch (e) {}
