; ClipboardTool NSIS 自定义脚本
; 全部入口快捷方式指向 task-launcher.exe：
; 由它经计划任务 ClipboardToolElevated（/rl highest）静默拉起提权主程序，不弹 UAC。
; 计划任务本身在提权后的首次运行中由主程序创建；安装时若用户已授权（安装器本身提权）也顺手兜底一次。

!macro customInstall
  ; 桌面快捷方式 -> 静默启动器
  CreateShortcut "$DESKTOP\ClipboardTool.lnk" "$INSTDIR\resources\resources\task-launcher.exe" "" "$INSTDIR\ClipboardTool.exe" 0
  ; 开始菜单快捷方式 -> 静默启动器
  CreateShortcut "$SMPROGRAMS\ClipboardTool.lnk" "$INSTDIR\resources\resources\task-launcher.exe" "" "$INSTDIR\ClipboardTool.exe" 0
!macroend

!macro customUnInstall
  ; 卸载：删除计划任务与自定义快捷方式
  ExecWait '"$SYSDIR\schtasks.exe" /delete /tn "ClipboardToolElevated" /f'
  Delete "$DESKTOP\ClipboardTool.lnk"
  Delete "$SMPROGRAMS\ClipboardTool.lnk"
!macroend