/**
 * @file
 * JS Integration between CiviCRM & Stripe.
 */
(function($, CRM) {

  var $form, $submit, buttonText;
  var isWebform = false;

  // Response from Stripe.createToken.
  function stripeResponseHandler(status, response) {
    if (response.error) {
      $('html, body').animate({scrollTop: 0}, 300);
      // Show the errors on the form.
      if ($(".messages.crm-error.stripe-message").length > 0) {
        $(".messages.crm-error.stripe-message").slideUp();
        $(".messages.crm-error.stripe-message:first").remove();
      }
      $form.prepend('<div class="messages crm-error stripe-message">'
        + '<strong>Payment Error Response:</strong>'
        + '<ul id="errorList">'
        + '<li>Error: ' + response.error.message + '</li>'
        + '</ul>'
        + '</div>');

      $submit.removeAttr('disabled').attr('value', buttonText);
    }
    else {
      var token = response['id'];
      // Update form with the token & submit.
      copyCCDetails($form);
      removeCCDetails($form);
      // We use the credit_card_number field to pass token as this is reliable.
      // Inserting an input field is unreliable on ajax forms and often gets missed from POST request for some reason.
      var ccNum = $form.find("input#credit_card_number").val();
      $form.find("input#credit_card_number").val(ccNum + token);

      // Disable unload event handler
      window.onbeforeunload = null;
      // This triggers submit without generating a submit event (so we don't run submit handler again)
      $form.get(0).submit();
    }
  }

  // Prepare the form.
  $(document).ready(function() {
    loadStripeBillingBlock();
  });

  // On the frontend, we have a set of radio buttons. Trigger on change.
  $('input[name="payment_processor_id"]').change(function() {
    loadStripeBillingBlock();
  });

  // On the backend, we have a select.  Trigger on change.
  $('select#payment_processor_id').change(function() {
    loadStripeBillingBlock();
  });

  function loadStripeBillingBlock() {
    var $stripePubKey = $('#stripe-pub-key');
    if ($stripePubKey.length) {
      if (!$().Stripe) {
        $.getScript('https://js.stripe.com/v2/', function () {
          Stripe.setPublishableKey($('#stripe-pub-key').val());
        });
      }
    }

    if ($('.webform-client-form').length) {
      isWebform = true;
    }

    // Get the form containing payment details
    $form = CRM.$('input#stripe-pub-key').closest('form');

    if (isWebform) {
      $submit = $form.find('.button-primary');
    }
    else {
      $submit = $form.find('input[type="submit"][formnovalidate!="1"]');

      // If another submit button on the form is pressed (eg. apply discount)
      //  add a flag that we can set to stop payment submission
      $form.data('submit-dont-process', '0');
      // Find submit buttons with formnovalidate=1 and add an onclick handler to set flag
      $form.find('input[type="submit"][formnovalidate="1"], input[type="submit"].cancel').click( function() {
        $form.data('submit-dont-process', 1);
      });
      // Add a keypress handler to set flag if enter is pressed
      $form.find('input#discountcode').keypress( function(e) {
        if (e.which === 13) {
          $form.data('submit-dont-process', 1);
        }
      });
    }

    // For CiviCRM Webforms.
    if (isWebform) {
      if (!($('#action').length)) {
        $form.append('<input type="hidden" name="op" id="action" />');
      }
      $(document).keypress(function(event) {
        if (event.which === 13) {
          // Enter was pressed
          event.preventDefault();
          submit(event);
        }
      });
      $(":submit").click(function() {
        $('#action').val(this.value);
      });
      $('#billingcheckbox:input').hide();
      $('label[for="billingcheckbox"]').hide();

      var webformPrevious = $('input.webform-previous').first().val();
    }
    else {
      // CiviCRM form
      // If we already have a token hide CC details
      if ($form.find("input#credit_card_number").val()) {
        $('.credit_card_info-group').hide();
        var $editCCButton = $form.find('input#ccButton');
        if (!$editCCButton.length) {
          $editCCButton = '<input type="button" value="Edit CC details" id="ccButton" />';
        }
        $('#billing-payment-block').append($editCCButton);
        $('#ccButton').click(function() {
          // Clear token and show CC details if edit button was clicked
          // As we use credit_card_number to pass token, make sure it is empty when shown
          $form.find("input#credit_card_number").val('');
          $form.find("input#cvv2").val('');
          $('.credit_card_info-group').show();
          $('#ccButton').hide();
        });
      }
      else {
        // As we use credit_card_number to pass token, make sure it is empty when shown
        $form.find("input#credit_card_number").val('');
        $form.find("input#cvv2").val('');
      }
    }

    $submit.removeAttr('onclick');
    $form.unbind('submit');

    // Intercept form submission.
    $form.submit(function (event) {
      event.preventDefault();
      submit(event);
    });

    function submit(event) {
      // Don't handle submits generated by non-stripe processors
      if (!$('input#stripe-pub-key').length) {
        debugging('submit missing stripe-pub-key element');
        return true;
      }
      // Don't handle submits generated by the CiviDiscount button.
      if ($form.data('submit-dont-process') === 1) {
        debugging('debug: pvjwy (Discount is in play)');
        return true;
      }
      if (isWebform) {
        var $processorFields = $('.civicrm-enabled[name$="civicrm_1_contribution_1_contribution_payment_processor_id]"]');

        if ($('#action').attr('value') === webformPrevious) {
          // Don't submit if the webform back button was pressed
          debugging('webform back button');
          return true;
        }
        if ($('#wf-crm-billing-total').length) {
          if ($('#wf-crm-billing-total').data('data-amount') === '0') {
            debugging('webform total is 0');
            return true;
          }
        }
        if ($processorFields.length) {
          if ($processorFields.filter(':checked').val() === '0') {
            debugging('no payment processor selected');
            return true;
          }
        }
      }
      // Disable the submit button to prevent repeated clicks, cache button text, restore if Stripe returns error
      buttonText = $submit.attr('value');
      $submit.prop('disabled', true).attr('value', 'Processing');

      // Handle multiple payment options and Stripe not being chosen.
      if ($form.find(".crm-section.payment_processor-section").length > 0) {
        var extMode = $('#ext-mode').val();
        var stripeProcessorId = $('#stripe-id').val();
        var chosenProcessorId = $form.find('input[name="payment_processor_id"]:checked').val();

        // Bail if we're not using Stripe or are using pay later (option value '0' in payment_processor radio group).
        if ((chosenProcessorId !== stripeProcessorId) || (chosenProcessorId === 0)) {
          debugging('debug: Not a Stripe transaction, or pay-later');
          return true;
        }
      }
      else {
        debugging('debug: Stripe is the selected payprocessor');
      }

      // If there's no credit card field, no use in continuing (probably wrong
      // context anyway)
      if (!$form.find('#credit_card_number').length) {
        debugging('debug: No credit card field');
        return true;
      }

      var cc_month = $form.find('#credit_card_exp_date_M').val();
      var cc_year = $form.find('#credit_card_exp_date_Y').val();

      Stripe.card.createToken({
        name:        $form.find('#billing_first_name').val() + ' ' + $form.find('#billing_last_name').val(),
        address_zip: $form.find('#billing_postal_code-5').val(),
        number:      $form.find('#credit_card_number').val(),
        cvc:         $form.find('#cvv2').val(),
        exp_month:   cc_month,
        exp_year:    cc_year
      }, stripeResponseHandler);

      debugging('debug: Getting Stripe token');
      return false;
    }
  }
}(cj, CRM));

function removeCCDetails($form) {
  // Remove the "name" attribute so params are not submitted
  var ccNumElement = $form.find("input#credit_card_number");
  var cvv2Element = $form.find("input#cvv2");
  var last4digits = ccNumElement.val().substr(12,16);
  ccNumElement.val('000000000000' + last4digits);
  cvv2Element.val('000');
}

function copyCCDetails($form) {
  // Remove the "name" attribute so params are not submitted
  var ccNumElement = $form.find("input#credit_card_number");
  var cvv2Element = $form.find("input#cvv2");
  var ccNum = ccNumElement.val();
  var cvv2Num = cvv2Element.val();
  var ccDummyElement = ccNumElement.clone();
  var cvv2DummyElement = cvv2Element.clone();
  ccNumElement.css('display', 'none');
  cvv2Element.css('display', 'none');
  ccDummyElement.removeAttr('name').removeAttr('id');
  cvv2DummyElement.removeAttr('name').removeAttr('id');
  ccDummyElement.insertAfter(ccNumElement);
  cvv2DummyElement.insertAfter(cvv2Element);
}

function debugging (errorCode) {
  // Uncomment the following to debug unexpected returns.
    console.log(errorCode);
}

