// AG Studio theme from the site's tokens. Every value is a CSS variable from studio.css, so one theme object serves both
// looks (ink and paper): the page switches data-ag-theme-mode and Studio, its grids, charts and our widgets follow.
import { studioTheme } from 'ag-studio'

const v = (name: string) => `var(--st-${name})`
const line = (color: string, width = 1) => ({ width, color: v(color) })

const palette = Object.fromEntries(
  Array.from({ length: 10 }, (_, i) => [
    [`chartPaletteFills${i + 1}Color`, v(`c${i + 1}`)],
    [`chartPaletteStrokes${i + 1}Color`, v(`c${i + 1}`)],
  ]).flat(),
)

export const rabStudioTheme = studioTheme
  .withParams({
    // shared by Studio's UI, grids and charts
    fontFamily: v('font'),
    fontSize: 13,
    textColor: v('text'),
    foregroundColor: v('text'),
    subtleTextColor: v('mute'),
    backgroundColor: v('surface'),
    borderColor: v('line'),
    accentColor: v('accent'),
    iconColor: v('soft'),
    rowHoverColor: v('surface-3'),

    // canvas: the page itself, widgets are "tags" laid on it
    studioWrapperBorder: false,
    studioWrapperBorderRadius: 0,
    studioWrapperSpacing: 0,
    studioWrapperBackgroundColor: v('canvas'),
    studioCanvasBorder: false,
    studioCanvasBorderRadius: 0,
    studioCanvasShadow: false,
    studioCanvasBackgroundColor: v('canvas'),
    studioCanvasPadding: 16,
    studioCanvasRowHeight: 18,
    studioCanvasFontFamily: v('font'),

    studioWidgetBackgroundColor: v('surface'),
    studioWidgetBorder: line('line'),
    studioWidgetBorderRadius: 14,
    studioWidgetPadding: 12,
    studioWidgetTitleFontFamily: v('display'),
    studioWidgetTitleFontSize: 16,
    studioWidgetTitleFontWeight: 700,
    studioWidgetTitleTextColor: v('text'),
    studioWidgetSubtitleFontFamily: v('mono'),
    studioWidgetSubtitleFontSize: 11,
    studioWidgetSubtitleTextColor: v('mute'),
    studioWidgetCaptionFontFamily: v('mono'),
    studioWidgetCaptionFontSize: 11,
    studioWidgetCaptionTextColor: v('mute'),
    studioWidgetResizeBorderColor: v('accent'),

    // edit-mode panels read as part of the console
    studioPanelContainerBackgroundColor: v('surface'),
    studioPanelContainerBorder: line('line'),
    studioPanelContainerBorderRadius: 0,
    studioPanelDividerColor: v('line'),
    studioPanelDividerActiveColor: v('accent'),
    studioPanelSectionBorderColor: v('line'),
    studioPanelHeaderFontFamily: v('display'),
    studioPanelHeaderFontWeight: 700,
    studioPanelChevronButtonHoverBackgroundColor: v('surface-3'),
    studioPanelChevronButtonHoverColor: v('accent'),
    studioToggleButtonActiveBackgroundColor: v('surface-3'),
    studioToggleButtonActiveBorderColor: v('accent'),
    studioToggleButtonActiveColor: v('accent'),

    // grid widgets: mono headers like the Ops tables, dashed receipt dividers
    gridFontFamily: v('font'),
    gridFontSize: 13,
    gridCellTextColor: v('text'),
    gridHeaderBackgroundColor: v('surface-2'),
    gridHeaderTextColor: v('mute'),
    gridHeaderFontFamily: v('mono'),
    gridHeaderFontWeight: 500,
    gridHeaderFontSize: 11,
    gridRowHeight: 36,
    gridRowBorder: line('line-soft'),
    gridHeaderRowBorder: line('line'),
    gridPinnedRowBorder: line('line'),
    gridRowHoverColor: v('surface-3'),
    gridWrapperBorder: false,

    // charts
    chartFontFamily: v('font'),
    chartTextColor: v('text'),
    chartSubtleTextColor: v('mute'),
    chartAxisLineColor: v('line'),
    chartGridLineColor: v('line-soft'),
    ...palette,
  } as never)
  .withParams({ browserColorScheme: 'dark' } as never, 'ink')
  .withParams({ browserColorScheme: 'light' } as never, 'paper')
