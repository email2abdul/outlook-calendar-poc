// Dynamics 365 — open the BIS brief side pane for the open lead.
//
// This is your existing openCustomSidePane(...) with two changes:
//   1. read the lead's fields from the form context, and
//   2. pass them to the web resource via the side pane's `data` parameter
//      (also handle the "pane already open" case so switching leads refreshes it).
//
// Register it on the Lead form's OnLoad (or your ribbon button), same as before.

function openCustomSidePane(executionContext) {
  var formContext = executionContext.getFormContext();

  function val(name) {
    var a = formContext.getAttribute(name);
    var v = a && a.getValue ? a.getValue() : '';
    return v == null ? '' : String(v);
  }

  // Pack the fields the brief matches on into the `data` string.
  var data = new URLSearchParams({
    email: val('emailaddress1'),
    firstName: val('firstname'),
    lastName: val('lastname'),
    company: val('companyname'),
  }).toString();

  var nav = {
    pageType: 'webresource',
    webresourceName: 'abc_customsidebarpage.html',
    data: data,
  };

  var existing = Xrm.App.sidePanes.getPane('myCustomPane');
  if (existing) {
    // Pane already open (e.g. switched to another lead) → just refresh it.
    existing.navigate(nav);
  } else {
    Xrm.App.sidePanes
      .createPane({
        paneId: 'myCustomPane',
        title: 'My Custom Panel',
        canClose: true,
        width: 400,
      })
      .then(function (pane) {
        pane.navigate(nav);
      });
  }
}
